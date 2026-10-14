// Signing in (ADR 0020) through `createApp` over HTTP with a real database.
//
// Ways it could fail, each covered below:
// - Joining works while no passcode is set, with a wrong passcode, or with a
//   taken or badly sized username, or a refused join still creates a Person.
// - A joined key is not daily, belongs to the wrong Person, or reaches the
//   Host's routes.
// - The passcode is not readable back, not trimmed, does not survive a
//   restart, or a blank one leaves joining open.
// - A Sign-in Code yields a key twice, after 10 minutes, or for a Person
//   removed since it was issued.
// - A Sign-in Code is lost when the Group restarts, or an earlier code for
//   the same Person still works after a new one is issued.
// - A blank device name spends the code without minting a key.
// - A friend's key reaches /admin, or a second Host key does not.
// - A node key reaches the client routes.
// - Guessing codes or passcodes is not limited, a key on the request skips
//   the limit, or a client over the limit spends a real code.
// - A different spelling of the route path, a burst of concurrent guesses,
//   or a fresh IPv6 address for each guess skips the limit.
// - Guesses spread over many addresses meet no limit at all.
// - A passcode shorter than eight characters is accepted.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SignedInSchema, SignInCodeSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken, readTrustStrict } from "./identity.js";
import { storedKey } from "./test-app.js";
import { request } from "./test-http.js";

const HOST_DAILY = "sign-in-host-daily";
const HOST_LAPTOP = "sign-in-host-laptop";
const FRIEND_DAILY = "sign-in-friend-daily";
const NODE = "sign-in-node";
const TEN_MINUTES = 10 * 60 * 1000;

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-sign-in-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        storedKey("host-daily", "host", HOST_DAILY, "daily"),
        storedKey("host-laptop", "host", HOST_LAPTOP, "daily"),
        storedKey("friend-daily", "friend", FRIEND_DAILY, "daily"),
        storedKey("host-node", "host", NODE, "node"),
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

    expect(await statusOf(setPasscode(app, "changed-now"))).toBe(200);
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
      await bodyOf(call(first, "GET", "/admin/passcode", { key: HOST_LAPTOP }))
    ).toEqual({ passcode: null });
    expect(await statusOf(setPasscode(first, "kept-safe", HOST_LAPTOP))).toBe(
      200
    );
  } finally {
    await first.dispose();
  }
  const second = open();
  try {
    expect(
      await bodyOf(call(second, "GET", "/admin/passcode", { key: HOST_DAILY }))
    ).toEqual({ passcode: "kept-safe" });
    expect(await bodyOf(setPasscode(second, "   "))).toEqual({
      passcode: null,
    });
    expect(
      await statusOf(
        join(second, { passcode: "kept-safe", username: "newcomer" })
      )
    ).toBe(403);
    expect(await statusOf(setPasscode(second, "kept-safe"))).toBe(200);
    expect(await bodyOf(setPasscode(second, null))).toEqual({
      passcode: null,
    });
    expect(
      await bodyOf(
        join(second, { passcode: "kept-safe", username: "newcomer" })
      )
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

test("a Person has one Sign-in Code, which survives a restart and expires after 10 minutes", async () => {
  const { cleanup, clock, open, store } = await setup();
  const first = open();
  let restarted: App | undefined;
  try {
    const replaced = await issueOwn(first, HOST_DAILY);
    const friend = await issueOwn(first, FRIEND_DAILY);
    const current = await issueOwn(first, HOST_LAPTOP);
    expect(store().signInCodes?.map((code) => code.personId)).toEqual([
      "friend",
      "host",
    ]);
    expect(await statusOf(redeem(first, replaced.code))).toBe(404);

    await first.dispose();
    restarted = open();
    clock.now += TEN_MINUTES - 1;
    expect(await statusOf(redeem(restarted, current.code))).toBe(200);
    clock.now += 1;
    expect(await statusOf(redeem(restarted, friend.code))).toBe(404);
    expect(store().signInCodes).toEqual([]);
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

    const issued = await call(app, "POST", url, { key: HOST_LAPTOP });
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
    for (const key of [HOST_DAILY, HOST_LAPTOP]) {
      // oxlint-disable-next-line no-await-in-loop
      const me = await call(app, "GET", "/me", { key });
      expect(me.json()).toMatchObject({ host: true, id: "host" });
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(call(app, "GET", "/admin/people", { key }))
      ).toBe(200);
    }
    const created = await call(app, "POST", "/admin/people/friend/keys", {
      key: HOST_LAPTOP,
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
    expect(await statusOf(setPasscode(app, "orbit-rings"))).toBe(200);
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
        join(
          app,
          { passcode: "orbit-rings", username: "blocked" },
          "100.64.0.3"
        )
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

test("a passcode needs eight characters, and a blank one still closes joining", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const short = await setPasscode(app, "orbit");
    expect(short.statusCode).toBe(400);
    expect(short.json()).toEqual({
      message: "A passcode needs at least 8 characters.",
    });
    expect(await statusOf(setPasscode(app, "   seven  "))).toBe(400);
    expect(await bodyOf(setPasscode(app, "orbit 42"))).toEqual({
      passcode: "orbit 42",
    });
    expect(await bodyOf(setPasscode(app, "   "))).toEqual({ passcode: null });
    expect(
      await statusOf(join(app, { passcode: "orbit 42", username: "late" }))
    ).toBe(403);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("another spelling of the sign-in path still counts toward the limit", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const spellings = ["/sign-in/code/", "//sign-in//code", "/SIGN-IN/CODE"];
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await call(
        app,
        "POST",
        spellings[attempt % spellings.length] ?? "/sign-in/code",
        {
          client: "100.64.0.7",
          payload: { code: `GUESS${attempt}`, label: "New phone" },
        }
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 20)).not.toContain(429);
    expect(statuses[20]).toBe(429);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("a burst of concurrent guesses cannot slip under the limit", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    expect(await statusOf(setPasscode(app, "orbit-rings"))).toBe(200);
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, attempt) =>
        statusOf(
          join(
            app,
            { passcode: `guess-${attempt}`, username: `burst${attempt}` },
            "100.64.0.8"
          )
        )
      )
    );
    expect(burst.filter((status) => status === 403)).toHaveLength(20);
    expect(burst.filter((status) => status === 429)).toHaveLength(20);
    expect(
      await statusOf(
        join(app, { passcode: "orbit-rings", username: "late" }, "100.64.0.8")
      )
    ).toBe(429);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("IPv6 guesses share one count per /64 block", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await redeem(app, `GUESS${attempt}`, {
        client: `2001:db8:1:2::${(attempt + 1).toString(16)}`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 20)).not.toContain(429);
    expect(statuses[20]).toBe(429);
    expect(
      await statusOf(redeem(app, "GUESS", { client: "2001:db8:1:3::1" }))
    ).toBe(404);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("guesses spread over many addresses meet one limit for the whole Group", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    expect(await statusOf(setPasscode(app, "orbit-rings"))).toBe(200);
    const issued = await issueOwn(app, FRIEND_DAILY);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 101; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await redeem(app, `GUESS${attempt}`, {
        client: `10.${Math.floor(attempt / 256)}.${attempt % 256}.1`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 100)).not.toContain(429);
    expect(statuses[100]).toBe(429);
    // The Group-wide limit refuses a real code too, until the window passes.
    expect(
      await statusOf(redeem(app, issued.code, { client: "10.9.9.9" }))
    ).toBe(429);
    // A signed-in device is not locked out of its own routes.
    expect(
      await statusOf(
        call(app, "GET", "/me", { client: "10.9.9.9", key: FRIEND_DAILY })
      )
    ).toBe(200);
  } finally {
    await app.dispose();
    await cleanup();
  }
});
