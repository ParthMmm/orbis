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
