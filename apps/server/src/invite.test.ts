// Invites (ADR 0016) through `createApp` over HTTP on the device listener.
//
// Ways an Invite could fail, each covered below:
// - A Person without the admin scope creates one, or one is created for a
//   missing or removed Person.
// - The trust store keeps the code itself, not its `sha256`, or loses the
//   Invite on a restart.
// - A code yields a key twice, after expiry, for an unknown code, or for a
//   Person removed after the Invite was made.
// - A claim yields an admin key, a key for the wrong Person, or a key with the
//   wrong label.
// - A claim with a blank label spends the code without minting a key.
// - Guessing codes is not limited, or a key on the request skips the limit.
// - A browser on a foreign Origin reaches the claim route.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

const HOST_DAILY = "invite-host-daily";
const HOST_ADMIN = "invite-host-admin";
const FRIEND_DAILY = "invite-friend-daily";
const WEB_ORIGIN = "https://orbis.p11a.xyz";

const Created = Schema.Struct({
  code: Schema.String,
  expiresAt: Schema.String,
});
const Claimed = Schema.Struct({
  key: Schema.String,
  person: Schema.Struct({ id: Schema.String, username: Schema.String }),
});
const StoredKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      personId: Schema.String,
      scope: Schema.String,
      tokenHash: Schema.String,
    })
  ),
});

const seedKey = (
  id: string,
  personId: string,
  token: string,
  scope: string
) => ({
  addedAt: new Date().toISOString(),
  id,
  label: id,
  lastUsedAt: null,
  personId,
  scope,
  tokenHash: hashToken(token),
});

const setup = async (options: { inviteTtlMs?: number } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-invite-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        seedKey("host-daily", "host", HOST_DAILY, "daily"),
        seedKey("host-admin", "host", HOST_ADMIN, "admin"),
        seedKey("friend-daily", "friend", FRIEND_DAILY, "daily"),
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "friend" },
        { id: "gone", removed: true, username: "gone" },
      ],
      version: 2,
    })
  );
  const open = () =>
    createApp({
      databasePath: path.join(directory, "library.sqlite"),
      devicesPath,
      ...options,
    });
  const storeText = () => readFile(devicesPath, "utf-8");
  const storedKeys = async () =>
    Schema.decodeUnknownSync(StoredKeys)(JSON.parse(await storeText())).keys;
  const cleanup = () => rm(directory, { force: true, recursive: true });
  return { cleanup, open, storeText, storedKeys };
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
    origin?: string;
  } = {}
) => {
  const headers: Record<string, string> = {};
  if (options.key) {
    headers.authorization = `Bearer ${options.key}`;
  }
  if (options.origin) {
    headers.origin = options.origin;
  }
  return request(app, {
    accessMode: "device",
    clientAddress: options.client ?? "100.64.0.1",
    headers,
    host: "vanta.example.ts.net",
    method,
    payload: options.payload,
    url,
  });
};

const create = async (app: App, personId = "friend") => {
  const response = await call(
    app,
    "POST",
    `/admin/people/${personId}/invites`,
    {
      key: HOST_ADMIN,
    }
  );
  expect(response.statusCode).toBe(201);
  return Schema.decodeUnknownSync(Created)(response.json());
};

const claim = (
  app: App,
  code: string,
  options: { label?: string; client?: string; key?: string } = {}
) =>
  call(app, "POST", "/invites/claim", {
    client: options.client,
    key: options.key,
    origin: WEB_ORIGIN,
    payload: { code, label: options.label ?? "Friend's laptop" },
  });

const statusOf = (response: ReturnType<typeof call>) =>
  response.then(({ statusCode }) => statusCode);

test("a claimed Invite yields one daily key for its Person, once", async () => {
  const { cleanup, open, storeText, storedKeys } = await setup();
  const app = open();
  try {
    const before = Date.now();
    const invite = await create(app);
    expect(invite.code.length).toBeGreaterThanOrEqual(40);
    const ttl = Date.parse(invite.expiresAt) - before;
    expect(ttl).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    const stored = await storeText();
    expect(stored).not.toContain(invite.code);
    expect(stored).toContain(hashToken(invite.code));

    const claimed = await claim(app, invite.code, {
      label: " Friend's laptop ",
    });
    expect(claimed.statusCode).toBe(200);
    const result = Schema.decodeUnknownSync(Claimed)(claimed.json());
    expect(result.person).toEqual({ id: "friend", username: "friend" });
    expect([HOST_DAILY, HOST_ADMIN, FRIEND_DAILY]).not.toContain(result.key);

    const me = await call(app, "GET", "/me", { key: result.key });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: "friend", username: "friend" });
    const keys = await storedKeys();
    const minted = keys.find((key) => key.tokenHash === hashToken(result.key));
    expect(minted).toMatchObject({
      label: "Friend's laptop",
      personId: "friend",
      scope: "daily",
    });
    expect(await storeText()).not.toContain(result.key);
    expect(
      await statusOf(call(app, "GET", "/admin/people", { key: result.key }))
    ).toBe(403);

    const again = await claim(app, invite.code);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      message: "This Invite has already been used. Ask the Host for a new one.",
    });
    expect(await storedKeys()).toHaveLength(4);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("an Invite for Host still yields only a daily key", async () => {
  const { cleanup, open, storedKeys } = await setup();
  const app = open();
  try {
    const invite = await create(app, "host");
    const claimed = await claim(app, invite.code);
    const result = Schema.decodeUnknownSync(Claimed)(claimed.json());
    expect(result.person).toEqual({ id: "host", username: "host" });
    const keys = await storedKeys();
    const minted = keys.find((key) => key.tokenHash === hashToken(result.key));
    expect(minted).toMatchObject({ personId: "host", scope: "daily" });
    expect(
      await statusOf(call(app, "GET", "/admin/keys", { key: result.key }))
    ).toBe(403);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("creating an Invite needs the admin scope and a current Person", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const url = "/admin/people/friend/invites";
    expect(await statusOf(call(app, "POST", url, { key: HOST_DAILY }))).toBe(
      403
    );
    expect(await statusOf(call(app, "POST", url, { key: FRIEND_DAILY }))).toBe(
      403
    );
    expect(await statusOf(call(app, "POST", url))).toBe(403);
    expect(await statusOf(call(app, "POST", url, { key: "not-a-key" }))).toBe(
      401
    );
    for (const id of ["nobody", "gone"]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(
          call(app, "POST", `/admin/people/${id}/invites`, { key: HOST_ADMIN })
        )
      ).toBe(404);
    }
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("an expired Invite yields no key", async () => {
  const { cleanup, open, storedKeys } = await setup({ inviteTtlMs: 50 });
  const app = open();
  try {
    const invite = await create(app);
    await Bun.sleep(80);
    const late = await claim(app, invite.code);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toEqual({
      message: "This Invite has expired. Ask the Host for a new one.",
    });
    expect(await storedKeys()).toHaveLength(3);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("an Invite for a Person removed later yields no key", async () => {
  const { cleanup, open, storedKeys } = await setup();
  const app = open();
  try {
    const invite = await create(app);
    expect(
      await statusOf(
        call(app, "DELETE", "/admin/people/friend", { key: HOST_ADMIN })
      )
    ).toBe(200);
    expect(await statusOf(claim(app, invite.code))).toBe(404);
    const keys = await storedKeys();
    expect(keys.filter((key) => key.personId === "friend")).toEqual([]);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("an Invite survives a restart", async () => {
  const { cleanup, open } = await setup();
  const first = open();
  const invite = await create(first);
  await first.dispose();
  const second = open();
  try {
    const claimed = await claim(second, invite.code);
    expect(claimed.statusCode).toBe(200);
    expect(Schema.decodeUnknownSync(Claimed)(claimed.json()).person.id).toBe(
      "friend"
    );
  } finally {
    await second.dispose();
    await cleanup();
  }
});

test("a blank device name or malformed body keeps the Invite", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const invite = await create(app);
    for (const label of ["", "   ", "x".repeat(101)]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await statusOf(claim(app, invite.code, { label }))).toBe(400);
    }
    expect(
      await statusOf(
        call(app, "POST", "/invites/claim", { payload: { code: invite.code } })
      )
    ).toBe(400);
    expect(
      await statusOf(
        call(app, "POST", "/invites/claim", {
          origin: "https://evil.example",
          payload: { code: invite.code, label: "Phish" },
        })
      )
    ).toBe(403);
    expect(await statusOf(claim(app, invite.code))).toBe(200);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("failed claims count toward the failed-key limit", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const invite = await create(app);
    const guesses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const guess = await claim(app, `guess-${attempt}`, {
        client: "100.64.0.3",
      });
      guesses.push(guess.statusCode);
    }
    expect(guesses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 404));
    expect(guesses[20]).toBe(429);
    // Once tripped, the client is refused before the code is spent.
    expect(
      await statusOf(claim(app, invite.code, { client: "100.64.0.3" }))
    ).toBe(429);

    // A key on the request does not skip the limit.
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await claim(app, `keyed-${attempt}`, {
        client: "100.64.0.4",
        key: FRIEND_DAILY,
      });
    }
    expect(
      await statusOf(
        claim(app, invite.code, { client: "100.64.0.4", key: FRIEND_DAILY })
      )
    ).toBe(429);

    // Bad keys and Invite guesses share one count per client.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await call(app, "GET", "/me", { client: "100.64.0.5", key: "bad" });
    }
    expect(await statusOf(claim(app, "guess", { client: "100.64.0.5" }))).toBe(
      429
    );

    expect(
      await statusOf(claim(app, invite.code, { client: "100.64.0.6" }))
    ).toBe(200);
  } finally {
    await app.dispose();
    await cleanup();
  }
});
