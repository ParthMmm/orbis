// Signing in (ADR 0020) through `createApp` over HTTP with a real database.
//
// Ways it could fail, each covered below:
// - Joining works while no passcode is set, with a wrong passcode, or with a
//   taken or badly sized username, or a refused join still creates a Person.
// - A joined key is not daily, belongs to the wrong Person, or reaches the
//   Host's routes.
// - The passcode is not readable back, not trimmed, does not survive a
//   restart, or a blank one leaves joining open.
// - A Sign-in Code yields a key twice, after 10 minutes, after a restart, or
//   for a Person removed since it was issued.
// - A blank device name spends the code without minting a key.
// - A friend's key reaches /admin, or the Host's old admin-scope key stops
//   working there.
// - A node key reaches the client routes.
// - Guessing codes or passcodes is not limited, a key on the request skips
//   the limit, or a client over the limit spends a real code.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SignedInSchema, SignInCodeSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken, readTrustStrict } from "./identity.js";
import { request } from "./test-http.js";

const HOST_DAILY = "sign-in-host-daily";
const HOST_ADMIN = "sign-in-host-admin";
const FRIEND_DAILY = "sign-in-friend-daily";
const NODE = "sign-in-node";
const TEN_MINUTES = 10 * 60 * 1000;

const seedKey = (
  id: string,
  personId: string,
  token: string,
  scope: string
) => ({
  addedAt: "2026-01-01T00:00:00.000Z",
  id,
  label: id,
  lastUsedAt: null,
  personId,
  scope,
  tokenHash: hashToken(token),
});

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-sign-in-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        seedKey("host-daily", "host", HOST_DAILY, "daily"),
        seedKey("host-admin", "host", HOST_ADMIN, "admin"),
        seedKey("friend-daily", "friend", FRIEND_DAILY, "daily"),
        seedKey("host-node", "host", NODE, "node"),
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "Friend" },
        { id: "gone", removed: true, username: "gone" },
      ],
      version: 2,
    })
  );
  const clock = { now: Date.now() };
  const open = () =>
    createApp({
      databasePath: path.join(directory, "library.sqlite"),
      devicesPath,
      signInCodeNow: () => clock.now,
    });
  const store = () => readTrustStrict(devicesPath);
  const cleanup = () => rm(directory, { force: true, recursive: true });
  return { cleanup, clock, open, store };
};

type App = ReturnType<typeof createApp>;

const call = (
  app: App,
  method: string,
  url: string,
  options: {
    key?: string | undefined;
    payload?: unknown;
    client?: string | undefined;
  } = {}
) =>
  request(app, {
    accessMode: "device",
    clientAddress: options.client ?? "100.64.0.1",
    headers: options.key ? { authorization: `Bearer ${options.key}` } : {},
    host: "vanta.example.ts.net",
    method,
    payload: options.payload,
    url,
  });
const statusOf = (response: ReturnType<typeof call>) =>
  response.then(({ statusCode }) => statusCode);
const bodyOf = (response: ReturnType<typeof call>) =>
  response.then((settled) => settled.json());

const decodeCode = Schema.decodeUnknownSync(SignInCodeSchema);
const decodeSignedIn = Schema.decodeUnknownSync(SignedInSchema);

const setPasscode = (app: App, passcode: string | null, key = HOST_DAILY) =>
  call(app, "PUT", "/admin/passcode", { key, payload: { passcode } });
const join = (
  app: App,
  input: { passcode: string; username: string; label?: string },
  client?: string
) =>
  call(app, "POST", "/sign-in/join", {
    client,
    payload: { label: "Phone", ...input },
  });
const issueOwn = async (app: App, key: string) => {
  const response = await call(app, "POST", "/me/sign-in-codes", { key });
  expect(response.statusCode).toBe(201);
  return decodeCode(response.json());
};
const redeem = (
  app: App,
  code: string,
  options: { label?: string; client?: string; key?: string } = {}
) =>
  call(app, "POST", "/sign-in/code", {
    client: options.client,
    key: options.key,
    payload: { code, label: options.label ?? "New phone" },
  });

test("a friend joins with the Group Passcode and gets one daily key", async () => {
  const { cleanup, open, store } = await setup();
  const app = open();
  try {
    const closed = await join(app, { passcode: "", username: "newcomer" });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toEqual({ message: "Joining is closed." });

    const set = await setPasscode(app, "  orbit 42  ");
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ passcode: "orbit 42" });
    expect(
      await bodyOf(call(app, "GET", "/admin/passcode", { key: HOST_DAILY }))
    ).toEqual({ passcode: "orbit 42" });

    expect(
      await statusOf(join(app, { passcode: "orbit 41", username: "newcomer" }))
    ).toBe(403);
    // The passcode is checked first, so a wrong one says nothing of the name.
    expect(
      await statusOf(join(app, { passcode: "nope", username: "friend" }))
    ).toBe(403);
    for (const username of ["", "   ", "x".repeat(41)]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(join(app, { passcode: "orbit 42", username }))
      ).toBe(400);
    }
    const taken = await join(app, { passcode: "orbit 42", username: "FRIEND" });
    expect(taken.statusCode).toBe(409);
    expect(store().people.map((person) => person.username)).toEqual([
      "host",
      "Friend",
      "gone",
    ]);

    const joined = await join(app, {
      label: " Newcomer's phone ",
      passcode: " orbit 42 ",
      username: " newcomer ",
    });
    expect(joined.statusCode).toBe(201);
    const result = decodeSignedIn(joined.json());
    expect(result.person.username).toBe("newcomer");
    const minted = store().keys.find(
      (key) => key.tokenHash === hashToken(result.key)
    );
    expect(minted).toMatchObject({
      label: "Newcomer's phone",
      personId: result.person.id,
      scope: "daily",
    });
    const me = await call(app, "GET", "/me", { key: result.key });
    expect(me.json()).toMatchObject({
      host: false,
      id: result.person.id,
      username: "newcomer",
    });
    expect(
      await statusOf(call(app, "GET", "/admin/people", { key: result.key }))
    ).toBe(403);

    expect(await statusOf(setPasscode(app, "changed"))).toBe(200);
    expect(await statusOf(call(app, "GET", "/me", { key: result.key }))).toBe(
      200
    );
    expect(
      await statusOf(join(app, { passcode: "orbit 42", username: "late" }))
    ).toBe(403);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("only the Host reads or sets the passcode, and it survives a restart", async () => {
  const { cleanup, open } = await setup();
  const first = open();
  try {
    for (const key of [FRIEND_DAILY, NODE]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await statusOf(call(first, "GET", "/admin/passcode", { key })))
        // oxlint-disable-next-line no-await-in-loop
        .toBe(403);
      // oxlint-disable-next-line no-await-in-loop
      expect(await statusOf(setPasscode(first, "taken over", key))).toBe(403);
    }
    expect(await statusOf(setPasscode(first, "x".repeat(101)))).toBe(400);
    expect(
      await bodyOf(call(first, "GET", "/admin/passcode", { key: HOST_ADMIN }))
    ).toEqual({ passcode: null });
    expect(await statusOf(setPasscode(first, "kept", HOST_ADMIN))).toBe(200);
  } finally {
    await first.dispose();
  }
  const second = open();
  try {
    expect(
      await bodyOf(call(second, "GET", "/admin/passcode", { key: HOST_DAILY }))
    ).toEqual({ passcode: "kept" });
    expect(await bodyOf(setPasscode(second, "   "))).toEqual({
      passcode: null,
    });
    expect(
      await statusOf(join(second, { passcode: "kept", username: "newcomer" }))
    ).toBe(403);
    expect(await statusOf(setPasscode(second, "kept"))).toBe(200);
    expect(await bodyOf(setPasscode(second, null))).toEqual({
      passcode: null,
    });
    expect(
      await bodyOf(join(second, { passcode: "kept", username: "newcomer" }))
    ).toEqual({ message: "Joining is closed." });
  } finally {
    await second.dispose();
    await cleanup();
  }
});

test("a Sign-in Code adds a device for its Person, once", async () => {
  const { cleanup, open, store } = await setup();
  const app = open();
  try {
    const issued = await issueOwn(app, FRIEND_DAILY);
    expect(issued.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(
      TEN_MINUTES - 5000
    );
    expect(store().keys).toHaveLength(4);

    const typed = `${issued.code.slice(0, 4).toLowerCase()}-${issued.code.slice(4)}`;
    for (const label of ["", "   "]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await statusOf(redeem(app, typed, { label }))).toBe(400);
    }
    const redeemed = await redeem(app, typed, { label: " Friend's iPad " });
    expect(redeemed.statusCode).toBe(200);
    const result = decodeSignedIn(redeemed.json());
    expect(result.person).toEqual({ id: "friend", username: "Friend" });
    const minted = store().keys.find(
      (key) => key.tokenHash === hashToken(result.key)
    );
    expect(minted).toMatchObject({
      label: "Friend's iPad",
      personId: "friend",
      scope: "daily",
    });
    const devices = await call(app, "GET", "/me/devices", { key: result.key });
    expect(devices.json()).toMatchObject({
      devices: [{ label: "friend-daily" }, { label: "Friend's iPad" }],
    });

    const again = await redeem(app, issued.code);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({
      message: "That code is not valid. Get a new one.",
    });
    expect(store().keys).toHaveLength(5);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("a Sign-in Code expires after 10 minutes and does not survive a restart", async () => {
  const { cleanup, clock, open, store } = await setup();
  const first = open();
  let restarted: App | undefined;
  try {
    const late = await issueOwn(first, HOST_DAILY);
    const inTime = await issueOwn(first, HOST_DAILY);
    clock.now += TEN_MINUTES - 1;
    expect(await statusOf(redeem(first, inTime.code))).toBe(200);
    clock.now += 1;
    expect(await statusOf(redeem(first, late.code))).toBe(404);

    const beforeRestart = await issueOwn(first, HOST_DAILY);
    await first.dispose();
    restarted = open();
    expect(await statusOf(redeem(restarted, beforeRestart.code))).toBe(404);
    expect(store().keys).toHaveLength(5);
  } finally {
    await (restarted ?? first).dispose();
    await cleanup();
  }
});

test("the Host issues a Sign-in Code for any current Person", async () => {
  const { cleanup, open, store } = await setup();
  const app = open();
  try {
    const url = "/admin/people/friend/sign-in-codes";
    expect(await statusOf(call(app, "POST", url, { key: FRIEND_DAILY }))).toBe(
      403
    );
    expect(await statusOf(call(app, "POST", url, { key: NODE }))).toBe(403);
    expect(await statusOf(call(app, "POST", url))).toBe(403);
    for (const id of ["nobody", "gone"]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(
          call(app, "POST", `/admin/people/${id}/sign-in-codes`, {
            key: HOST_DAILY,
          })
        )
      ).toBe(404);
    }

    const issued = await call(app, "POST", url, { key: HOST_ADMIN });
    expect(issued.statusCode).toBe(201);
    const { code } = decodeCode(issued.json());
    const result = decodeSignedIn(await bodyOf(redeem(app, code)));
    expect(result.person.id).toBe("friend");

    const removedLater = decodeCode(
      await bodyOf(call(app, "POST", url, { key: HOST_DAILY }))
    );
    expect(
      await statusOf(
        call(app, "DELETE", "/admin/people/friend", { key: HOST_DAILY })
      )
    ).toBe(200);
    expect(await statusOf(redeem(app, removedLater.code))).toBe(404);
    expect(store().keys.filter((key) => key.personId === "friend")).toEqual([]);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("Host powers follow the Host Person, and node keys stay off client routes", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    for (const key of [HOST_DAILY, HOST_ADMIN]) {
      // oxlint-disable-next-line no-await-in-loop
      const me = await call(app, "GET", "/me", { key });
      expect(me.json()).toMatchObject({ host: true, id: "host" });
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(call(app, "GET", "/admin/people", { key }))
      ).toBe(200);
    }
    const created = await call(app, "POST", "/admin/people/friend/keys", {
      key: HOST_ADMIN,
      payload: { label: "Laptop", scope: "admin" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      personId: "friend",
      scope: "daily",
    });

    const friend = await call(app, "GET", "/admin/people", {
      key: FRIEND_DAILY,
    });
    expect(friend.statusCode).toBe(403);
    expect(friend.json()).toEqual({ message: "Only the Host can do this." });
    expect(
      await bodyOf(call(app, "GET", "/me", { key: FRIEND_DAILY }))
    ).toMatchObject({ host: false });

    for (const url of ["/me", "/me/devices", "/sets"]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(call(app, "GET", url, { key: NODE }))
      ).toBe(403);
    }
    expect(
      await statusOf(call(app, "POST", "/me/sign-in-codes", { key: NODE }))
    ).toBe(403);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("wrong codes and passcodes count toward the failed-key limit", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    expect(await statusOf(setPasscode(app, "orbit"))).toBe(200);
    const issued = await issueOwn(app, FRIEND_DAILY);
    const guesses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const guess =
        attempt % 2 === 0
          ? // oxlint-disable-next-line no-await-in-loop
            await redeem(app, `GUESS${attempt}`, { client: "100.64.0.3" })
          : // oxlint-disable-next-line no-await-in-loop
            await join(
              app,
              { passcode: `guess-${attempt}`, username: `guess${attempt}` },
              "100.64.0.3"
            );
      guesses.push(guess.statusCode);
    }
    expect(guesses.slice(0, 20)).toEqual(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 404 : 403))
    );
    expect(guesses[20]).toBe(429);
    // Once over the limit, the client is refused before the code is spent.
    expect(
      await statusOf(redeem(app, issued.code, { client: "100.64.0.3" }))
    ).toBe(429);
    expect(
      await statusOf(
        join(app, { passcode: "orbit", username: "blocked" }, "100.64.0.3")
      )
    ).toBe(429);

    // A key on the request does not skip the limit.
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await redeem(app, `KEYED${attempt}`, {
        client: "100.64.0.4",
        key: FRIEND_DAILY,
      });
    }
    expect(
      await statusOf(
        redeem(app, issued.code, { client: "100.64.0.4", key: FRIEND_DAILY })
      )
    ).toBe(429);

    // Bad keys and code guesses share one count per client.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await call(app, "GET", "/me", { client: "100.64.0.5", key: "bad" });
    }
    expect(await statusOf(redeem(app, "GUESS", { client: "100.64.0.5" }))).toBe(
      429
    );

    expect(
      await statusOf(redeem(app, issued.code, { client: "100.64.0.6" }))
    ).toBe(200);
  } finally {
    await app.dispose();
    await cleanup();
  }
});
