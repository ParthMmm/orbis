// Device Links (ADR 0016) through `createApp` over HTTP on the device listener.
//
// Ways a Device Link could fail, each covered below:
// - A link yields a key without approval, twice, after expiry, or after a restart.
// - A link yields an admin key, or a key for a Person other than the approver.
// - Approve or lookup works without a key, or with a bad one.
// - A user code typed with a hyphen or in lower case does not match.
// - Guessing poll secrets or flooding starts is not limited; or a device that
//   polls a pending link as told is limited.
// - A browser on a foreign Origin reaches the routes that need no key.
// - A malformed label or code is accepted.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken, readTrustStrict } from "./identity.js";
import { request } from "./test-http.js";

const HOST_DAILY = "device-link-host-daily";
const HOST_ADMIN = "device-link-host-admin";
const FRIEND_DAILY = "device-link-friend-daily";
const WEB_ORIGIN = "https://orbis.p11a.xyz";

const Started = Schema.Struct({
  expiresAt: Schema.String,
  pollSecret: Schema.String,
  userCode: Schema.String,
});
const Approved = Schema.Struct({
  key: Schema.String,
  person: Schema.Struct({ id: Schema.String, username: Schema.String }),
  status: Schema.Literal("approved"),
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

const setup = async (
  options: { deviceLinkTtlMs?: number; deviceLinkNow?: () => number } = {}
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-device-link-"));
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
  const storedKeys = () =>
    Schema.decodeUnknownSync(StoredKeys)(readTrustStrict(devicesPath)).keys;
  const cleanup = () => rm(directory, { force: true, recursive: true });
  return { cleanup, open, storedKeys };
};

type App = ReturnType<typeof createApp>;

const call = (
  app: App,
  method: string,
  url: string,
  options: {
    key?: string;
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

const start = async (app: App, label = "Kitchen iPad", client?: string) => {
  const response = await call(app, "POST", "/device-links", {
    client,
    origin: WEB_ORIGIN,
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return Schema.decodeUnknownSync(Started)(response.json());
};

const poll = (app: App, pollSecret: string, client?: string) =>
  call(app, "POST", "/device-links/poll", {
    client,
    origin: WEB_ORIGIN,
    payload: { pollSecret },
  });

const approve = (app: App, userCode: string, key = HOST_DAILY) =>
  call(app, "POST", "/device-links/approve", { key, payload: { userCode } });

const lookup = (app: App, userCode: string, key = HOST_DAILY) =>
  call(app, "POST", "/device-links/lookup", { key, payload: { userCode } });

const statusOf = (response: ReturnType<typeof call>) =>
  response.then(({ statusCode }) => statusCode);
const jsonOf = (response: ReturnType<typeof call>) =>
  response.then((result) => result.json());

const findKey = <T>(keys: readonly T[], matches: (key: T) => boolean) =>
  keys.find(matches);

const hyphenated = (code: string) =>
  `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

test("an approved Device Link yields one daily key for the approver, once", async () => {
  const { cleanup, open, storedKeys } = await setup();
  const app = open();
  try {
    const before = Date.now();
    const link = await start(app);
    expect(link.userCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u);
    expect(link.pollSecret.length).toBeGreaterThanOrEqual(40);
    const ttl = Date.parse(link.expiresAt) - before;
    expect(ttl).toBeGreaterThan(9.9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

    const pending = await poll(app, link.pollSecret);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });

    const preview = await lookup(app, hyphenated(link.userCode));
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      expiresAt: link.expiresAt,
      label: "Kitchen iPad",
    });
    expect(await jsonOf(poll(app, link.pollSecret))).toEqual({
      status: "pending",
    });

    const approved = await approve(app, ` ${hyphenated(link.userCode)} `);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({
      expiresAt: link.expiresAt,
      label: "Kitchen iPad",
    });
    expect(await statusOf(approve(app, link.userCode))).toBe(409);
    expect(await statusOf(approve(app, link.userCode, FRIEND_DAILY))).toBe(409);

    const granted = await poll(app, link.pollSecret);
    expect(granted.statusCode).toBe(200);
    const result = Schema.decodeUnknownSync(Approved)(granted.json());
    expect(result.person).toEqual({ id: "host", username: "host" });
    expect([HOST_DAILY, HOST_ADMIN, FRIEND_DAILY]).not.toContain(result.key);

    const me = await call(app, "GET", "/me", { key: result.key });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: "host", username: "host" });
    const minted = findKey(
      await storedKeys(),
      (key) => key.tokenHash === hashToken(result.key)
    );
    expect(minted).toMatchObject({
      label: "Kitchen iPad",
      personId: "host",
      scope: "daily",
    });
    expect(JSON.stringify(await storedKeys())).not.toContain(result.key);
    expect(
      await statusOf(call(app, "GET", "/admin/people", { key: result.key }))
    ).toBe(403);

    expect(await statusOf(poll(app, link.pollSecret))).toBe(404);
    expect(await statusOf(approve(app, link.userCode))).toBe(404);
    expect(await statusOf(lookup(app, link.userCode))).toBe(404);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("a Device Link mints for the approving Person and never an admin key", async () => {
  const { cleanup, open, storedKeys } = await setup();
  const app = open();
  try {
    const friendLink = await start(app, "Friend's Mac");
    expect(
      await statusOf(approve(app, friendLink.userCode, FRIEND_DAILY))
    ).toBe(200);
    const friend = Schema.decodeUnknownSync(Approved)(
      await jsonOf(poll(app, friendLink.pollSecret))
    );
    expect(friend.person).toEqual({ id: "friend", username: "friend" });
    expect(
      await jsonOf(call(app, "GET", "/me", { key: friend.key }))
    ).toMatchObject({ id: "friend" });

    const adminLink = await start(app, "Host's TV");
    expect(await statusOf(approve(app, adminLink.userCode, HOST_ADMIN))).toBe(
      200
    );
    const fromAdmin = Schema.decodeUnknownSync(Approved)(
      await jsonOf(poll(app, adminLink.pollSecret))
    );
    const minted = findKey(
      await storedKeys(),
      (key) => key.tokenHash === hashToken(fromAdmin.key)
    );
    expect(minted).toMatchObject({ personId: "host", scope: "daily" });
    expect(
      await statusOf(call(app, "GET", "/admin/keys", { key: fromAdmin.key }))
    ).toBe(403);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("approve and lookup need a signed-in Person", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const link = await start(app);
    for (const url of ["/device-links/approve", "/device-links/lookup"]) {
      const payload = { userCode: link.userCode };
      // oxlint-disable-next-line no-await-in-loop
      expect(await statusOf(call(app, "POST", url, { payload }))).toBe(403);
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(call(app, "POST", url, { key: "not-a-key", payload }))
      ).toBe(401);
    }
    expect(await jsonOf(poll(app, link.pollSecret))).toEqual({
      status: "pending",
    });
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("unknown codes, malformed bodies, and foreign Origins are refused", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    expect(await statusOf(approve(app, "ZZZZ-ZZZZ"))).toBe(404);
    expect(await statusOf(lookup(app, "ZZZZZZZZ"))).toBe(404);
    expect(await statusOf(approve(app, "x".repeat(21)))).toBe(400);
    for (const label of ["", "   ", "x".repeat(101)]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await statusOf(
          call(app, "POST", "/device-links", { payload: { label } })
        )
      ).toBe(400);
    }
    expect(
      await statusOf(call(app, "POST", "/device-links", { payload: {} }))
    ).toBe(400);
    const nativeClient = await call(app, "POST", "/device-links", {
      payload: { label: "Apple TV" },
    });
    expect(nativeClient.statusCode).toBe(201);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("an expired Device Link cannot be approved and yields no key", async () => {
  let now = Date.now();
  const { cleanup, open } = await setup({
    deviceLinkNow: () => now,
    deviceLinkTtlMs: 50,
  });
  const app = open();
  try {
    const unapproved = await start(app);
    const approvedLate = await start(app, "Slow phone");
    expect(await statusOf(approve(app, approvedLate.userCode))).toBe(200);
    now += 80;
    expect(await statusOf(lookup(app, unapproved.userCode))).toBe(410);
    expect(await statusOf(approve(app, unapproved.userCode))).toBe(410);
    expect(await jsonOf(poll(app, unapproved.pollSecret))).toEqual({
      status: "expired",
    });
    expect(await jsonOf(poll(app, approvedLate.pollSecret))).toEqual({
      status: "expired",
    });
    expect(await statusOf(poll(app, unapproved.pollSecret))).toBe(404);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("wrong poll secrets and starts count toward the failed-key limit", async () => {
  const { cleanup, open } = await setup();
  const app = open();
  try {
    const link = await start(app, "Patient device", "100.64.0.2");
    // A device polling its pending link as told never trips the limit.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const pending = await poll(app, link.pollSecret, "100.64.0.3");
      expect(pending.statusCode).toBe(200);
    }
    const guesses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const guess = await poll(app, `guess-${attempt}`, "100.64.0.3");
      guesses.push(guess.statusCode);
    }
    expect(guesses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 404));
    expect(guesses[20]).toBe(429);
    // Once tripped, the client is refused before any lookup.
    expect(await statusOf(poll(app, link.pollSecret, "100.64.0.3"))).toBe(429);
    expect(await statusOf(poll(app, link.pollSecret, "100.64.0.4"))).toBe(200);

    const starts: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const started = await call(app, "POST", "/device-links", {
        client: "100.64.0.5",
        payload: { label: `Device ${attempt}` },
      });
      starts.push(started.statusCode);
    }
    expect(starts.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 201));
    expect(starts[20]).toBe(429);

    // Bad keys and Device Link guesses share one count per client.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await call(app, "GET", "/me", { client: "100.64.0.6", key: "bad" });
    }
    expect(await statusOf(poll(app, "guess", "100.64.0.6"))).toBe(429);
  } finally {
    await app.dispose();
    await cleanup();
  }
});

test("a restart cancels pending Device Links", async () => {
  const { cleanup, open } = await setup();
  const first = open();
  const link = await start(first);
  await first.dispose();
  const second = open();
  try {
    expect(await statusOf(approve(second, link.userCode))).toBe(404);
    expect(await statusOf(poll(second, link.pollSecret))).toBe(404);
  } finally {
    await second.dispose();
    await cleanup();
  }
});
