import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken, mutateTrustStore, readTrustStrict } from "./identity.js";
import { request } from "./test-http.js";

const TAILNET_HOST = "vanta.example.ts.net";

const withTrustStore = async (
  devices: readonly { id: string; label: string; token: string }[]
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-identity-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      devices: devices.map((device) => ({
        addedAt: "2026-09-11T00:00:00.000Z",
        id: device.id,
        label: device.label,
        tokenHash: hashToken(device.token),
      })),
      version: 1,
    })
  );
  return {
    app: createApp({
      databasePath: path.join(directory, "library.sqlite"),
      devicesPath,
    }),
    devicesPath,
    directory,
  };
};

test("device ingress rejects spoofed loopback authorities and invalid credentials", async () => {
  const token = crypto.randomUUID();
  const { app, directory, devicesPath } = await withTrustStore([
    { id: "fixture", label: "Fixture", token },
  ]);
  const deviceGet = {
    accessMode: "device",
    method: "GET",
    url: "/sets",
  } as const;
  // The last variant spoofs the Host header while the URL authority stays loopback.
  const spoofed = [
    { authority: "127.0.0.1:4310", host: "localhost" },
    { authority: "127.0.0.1:4310", host: "localhost:4310" },
    { authority: "127.0.0.1:4310", host: "127.0.0.1" },
    { authority: "127.0.0.1:4310", host: "127.0.0.1:4310" },
    { authority: "127.0.0.1:4310", host: TAILNET_HOST },
    { authority: TAILNET_HOST, host: "localhost" },
    { authority: TAILNET_HOST, host: "127.0.0.1:4310" },
  ];
  const loopbackHosts = [
    "localhost",
    "127.0.0.1",
    "localhost:4310",
    "127.0.0.1:4310",
  ];
  try {
    const unauthenticated = await Promise.all(
      spoofed.map(({ authority, host }) =>
        request(app, { ...deviceGet, headers: { host }, host: authority })
      )
    );
    expect(unauthenticated.map((response) => response.statusCode)).toEqual(
      spoofed.map(() => 403)
    );

    const invalidTokens = await Promise.all(
      spoofed.map(({ authority, host }) =>
        request(app, {
          ...deviceGet,
          headers: { authorization: "Bearer invalid", host },
          host: authority,
        })
      )
    );
    expect(invalidTokens.map((response) => response.statusCode)).toEqual(
      spoofed.map(() => 401)
    );

    // An invalid credential is still 401 on local ingress, never a silent fallback.
    const invalidLocal = await Promise.all(
      loopbackHosts.map((host) =>
        request(app, {
          headers: { authorization: "Bearer invalid", host },
          method: "GET",
          url: "/sets",
        })
      )
    );
    expect(invalidLocal.map((response) => response.statusCode)).toEqual(
      loopbackHosts.map(() => 401)
    );

    const paired = await request(app, {
      ...deviceGet,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(paired.statusCode).toBe(200);

    mutateTrustStore(
      devicesPath,
      () => readTrustStrict(devicesPath),
      (store) => ({ store: { ...store, keys: [] }, value: undefined })
    );
    const revoked = await request(app, {
      ...deviceGet,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.statusCode).toBe(401);

    await writeFile(devicesPath, "{invalid");
    const corrupt = await request(app, {
      ...deviceGet,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(corrupt.statusCode).toBe(401);

    await rm(`${devicesPath}.migrated`);
    const missing = await request(app, {
      ...deviceGet,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(401);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("accepts a paired device over the tailnet address and reads the library", async () => {
  const { app, directory } = await withTrustStore([
    { id: "iphone", label: "iPhone 17 Pro", token: "token-for-iphone" },
  ]);
  try {
    const saved = await request(app, {
      headers: { authorization: "Bearer token-for-iphone" },
      host: TAILNET_HOST,
      method: "POST",
      payload: {
        tags: ["techno"],
        title: "Saved from the tailnet",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);

    const library = await request(app, {
      headers: { authorization: "Bearer token-for-iphone" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(library.statusCode).toBe(200);
    expect(library.json()).toMatchObject({
      sets: [{ title: "Saved from the tailnet" }],
    });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects the tailnet address without a paired device", async () => {
  const { app, directory } = await withTrustStore([
    { id: "iphone", label: "iPhone 17 Pro", token: "token-for-iphone" },
  ]);
  try {
    const missing = await request(app, {
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({
      message: "Only local app requests are allowed.",
    });

    const wrongToken = await request(app, {
      headers: { authorization: "Bearer not-the-token" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(wrongToken.statusCode).toBe(401);
    expect(wrongToken.json()).toEqual({
      message: "This device is not paired with your library.",
    });

    const malformed = await request(app, {
      headers: { authorization: "token-for-iphone" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(malformed.statusCode).toBe(401);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("fails closed when the trust store is missing or unreadable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-identity-"));
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath: path.join(directory, "absent.json"),
  });
  try {
    const remote = await request(app, {
      headers: { authorization: "Bearer any-token" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(remote.statusCode).toBe(401);

    const local = await request(app, { method: "GET", url: "/sets" });
    expect(local.statusCode).toBe(403);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("accepts either enrolled device and reflects an enrolment without a restart", async () => {
  const { app, devicesPath, directory } = await withTrustStore([
    { id: "iphone", label: "iPhone 17 Pro", token: "token-for-iphone" },
  ]);
  try {
    const first = await request(app, {
      headers: { authorization: "Bearer token-for-iphone" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(first.statusCode).toBe(200);

    const beforeEnrolment = await request(app, {
      headers: { authorization: "Bearer token-for-mac" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(beforeEnrolment.statusCode).toBe(401);

    mutateTrustStore(
      devicesPath,
      () => readTrustStrict(devicesPath),
      (store) => ({
        store: {
          ...store,
          keys: [
            ...store.keys,
            {
              addedAt: "2026-09-11T00:01:00.000Z",
              id: "mac",
              label: "MacBook Pro",
              lastUsedAt: null,
              personId: "host",
              scope: "daily",
              tokenHash: hashToken("token-for-mac"),
            },
          ],
        },
        value: undefined,
      })
    );

    const afterEnrolment = await request(app, {
      headers: { authorization: "Bearer token-for-mac" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(afterEnrolment.statusCode).toBe(200);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("migration preserves digests and identities and ignores a recreated JSON file", async () => {
  const { app, devicesPath, directory } = await withTrustStore([
    { id: "iphone", label: "iPhone", token: "migration-token" },
  ]);
  try {
    const stored = readTrustStrict(devicesPath);
    expect(stored.keys[0]).toMatchObject({
      personId: "host",
      scope: "daily",
      tokenHash: hashToken("migration-token"),
    });
    expect(await Bun.file(`${devicesPath}.migrated`).exists()).toBe(true);
    expect(await Bun.file(devicesPath).exists()).toBe(false);
    await writeFile(devicesPath, JSON.stringify({ devices: [], version: 1 }));
    const response = await request(app, {
      accessMode: "device",
      headers: { authorization: "Bearer migration-token" },
      method: "GET",
      url: "/me",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "host" });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

// A trust database from before ADR 0020 still holds Invites that point at
// People. If the upgrade kept them, rewriting `people` would break their
// foreign keys, so removing a Person or setting the passcode would fail.
const PRE_PASSCODE_TRUST = `CREATE TABLE people (
      id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, removed INTEGER NOT NULL,
      social INTEGER NOT NULL DEFAULT 0, auto_download INTEGER NOT NULL DEFAULT 1,
      filters TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('daily', 'admin', 'node')), person_id TEXT NOT NULL REFERENCES people(id),
      added_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE invites (
      digest TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(id),
      expires_at TEXT NOT NULL, used INTEGER NOT NULL
    );
    CREATE TABLE trust_migrations (id INTEGER PRIMARY KEY CHECK (id = 1));
    INSERT INTO trust_migrations (id) VALUES (1);
    INSERT INTO people (id, username, removed) VALUES ('host', 'host', 0), ('friend', 'friend', 0);
    INSERT INTO invites VALUES ('${"0".repeat(64)}', 'friend', '2026-01-01T00:00:00.000Z', 0);`;

test("an existing trust database drops Invites and keeps the passcode across restarts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-identity-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(PRE_PASSCODE_TRUST);
    database
      .query(
        "INSERT INTO api_keys VALUES ('host-admin', ?, 'Recovery', 'admin', 'host', '2026-01-01T00:00:00.000Z', NULL)"
      )
      .run(hashToken("pre-passcode-admin"));
  } finally {
    database.close();
  }
  const host = { authorization: "Bearer pre-passcode-admin" };
  // Without a file database, only the trust adapter upgrades the trust file.
  const first = createApp({ devicesPath });
  try {
    const removed = await request(first, {
      headers: host,
      method: "DELETE",
      url: "/admin/people/friend",
    });
    expect(removed.statusCode).toBe(200);
    const set = await request(first, {
      headers: host,
      method: "PUT",
      payload: { passcode: "orbit" },
      url: "/admin/passcode",
    });
    expect(set.statusCode).toBe(200);
  } finally {
    await first.dispose();
  }
  const second = createApp({ devicesPath });
  try {
    const read = await request(second, {
      headers: host,
      method: "GET",
      url: "/admin/passcode",
    });
    expect(read.json()).toEqual({ passcode: "orbit" });
    const upgraded = new Database(databasePath, { readonly: true });
    try {
      expect(
        upgraded
          .query("SELECT name FROM sqlite_master WHERE name = 'invites'")
          .all()
      ).toEqual([]);
    } finally {
      upgraded.close();
    }
  } finally {
    await second.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
