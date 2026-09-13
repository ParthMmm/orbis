import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

const TAILNET_HOST = "vanta.tail01d084.ts.net";

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

    const origins = ["", "null", "https://example.com"];
    const browserOrigins = await Promise.all(
      origins.map((origin) =>
        request(app, {
          ...deviceGet,
          headers: { authorization: `Bearer ${token}`, origin },
        })
      )
    );
    expect(browserOrigins.map((response) => response.statusCode)).toEqual(
      origins.map(() => 403)
    );

    await writeFile(devicesPath, JSON.stringify({ devices: [], version: 1 }));
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

    await rm(devicesPath);
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

test("rejects a browser origin even when it carries a paired token", async () => {
  const { app, directory } = await withTrustStore([
    { id: "iphone", label: "iPhone 17 Pro", token: "token-for-iphone" },
  ]);
  try {
    const fromTailnet = await request(app, {
      headers: {
        authorization: "Bearer token-for-iphone",
        origin: "https://vanta.tail01d084.ts.net",
      },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(fromTailnet.statusCode).toBe(403);

    const nullOrigin = await request(app, {
      headers: { authorization: "Bearer token-for-iphone", origin: "null" },
      host: TAILNET_HOST,
      method: "GET",
      url: "/sets",
    });
    expect(nullOrigin.statusCode).toBe(403);

    const fromLoopback = await request(app, {
      headers: { origin: "http://localhost:5173" },
      method: "GET",
      url: "/sets",
    });
    expect(fromLoopback.statusCode).toBe(403);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps loopback access working and unchanged for the desktop client", async () => {
  const { app, directory } = await withTrustStore([]);
  try {
    const local = await request(app, { method: "GET", url: "/sets" });
    expect(local.statusCode).toBe(200);

    const localWithHost = await request(app, {
      host: "localhost:4310",
      method: "GET",
      url: "/sets",
    });
    expect(localWithHost.statusCode).toBe(200);
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
    expect(local.statusCode).toBe(200);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("fails closed when the trust store is not valid JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-identity-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(devicesPath, "{ not json");
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
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
    expect(local.statusCode).toBe(200);
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

    await writeFile(
      devicesPath,
      JSON.stringify({
        devices: [
          {
            addedAt: "2026-09-11T00:00:00.000Z",
            id: "iphone",
            label: "iPhone 17 Pro",
            tokenHash: hashToken("token-for-iphone"),
          },
          {
            addedAt: "2026-09-11T00:01:00.000Z",
            id: "mac",
            label: "MacBook Pro",
            tokenHash: hashToken("token-for-mac"),
          },
        ],
        version: 1,
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
