import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DeviceSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { addKey, addPerson } from "./admin.js";
import { createApp } from "./app.js";
import { emptyTrustStore } from "./identity.js";
import { request } from "./test-http.js";

// Ways the Devices routes can fail, written before the routes:
// 1. The list shows another Person's keys.
// 2. The list shows an admin-scope key, including the Host's own.
// 3. The list shows a token hash.
// 4. `current` marks the wrong key, or more than one key.
// 5. A Person revokes another Person's key, or learns that the id exists (403).
// 6. A Person revokes an admin key through this route.
// 7. A revoked key keeps working.
// 8. Revoking the key making the request fails, or leaves it working.
// 9. A request without a key, with a bad key, or on the local listener reaches
//    the routes and acts as the Host.
// 10. An admin-scope key uses the routes, so the admin key shows up as a device.

const call = (
  app: ReturnType<typeof createApp>,
  token: string | null,
  method: string,
  url: string
) =>
  request(app, {
    accessMode: "device",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    host: "vanta.example.ts.net",
    method,
    url,
  });

const decodeDevice = Schema.decodeUnknownSync(DeviceSchema);
const decodeDevices = Schema.decodeUnknownSync(
  Schema.Struct({ devices: Schema.Array(DeviceSchema) })
);
const statusOf = async (response: ReturnType<typeof call>) => {
  const { statusCode } = await response;
  return statusCode;
};
const devicesOf = async (response: ReturnType<typeof call>) => {
  const listed = await response;
  return decodeDevices(listed.json()).devices;
};

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-devices-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(devicesPath, JSON.stringify(emptyTrustStore()));
  const laptop = addKey(devicesPath, "host", { label: "Laptop" });
  const phone = addKey(devicesPath, "host", { label: "Phone" });
  const admin = addKey(devicesPath, "host", {
    label: "Recovery",
    scope: "admin",
  });
  const alice = addPerson(devicesPath, "alice");
  const aliceKey = addKey(devicesPath, alice.id, { label: "Alice phone" });
  const app = createApp({ databasePath, devicesPath });
  return {
    admin,
    aliceKey,
    app,
    cleanup: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
    laptop,
    phone,
  };
};

test("a Person lists only their own daily keys and sees which one is current", async () => {
  const { admin, aliceKey, app, cleanup, laptop, phone } = await setup();
  try {
    const listed = await call(app, laptop.token, "GET", "/me/devices");
    expect(listed.statusCode).toBe(200);
    const raw = JSON.stringify(listed.json());
    const { devices } = decodeDevices(listed.json());
    expect(new Set(devices.map((device) => device.id))).toEqual(
      new Set([laptop.id, phone.id])
    );
    expect(devices).toHaveLength(2);
    expect(devices.find((device) => device.id === laptop.id)).toEqual({
      addedAt: laptop.addedAt,
      current: true,
      id: laptop.id,
      label: "Laptop",
      lastUsedAt: expect.any(String),
    });
    expect(devices.find((device) => device.id === phone.id)).toEqual({
      addedAt: phone.addedAt,
      current: false,
      id: phone.id,
      label: "Phone",
      lastUsedAt: null,
    });
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain(admin.id);
    expect(raw).not.toContain(aliceKey.id);

    const phoneView = await devicesOf(
      call(app, phone.token, "GET", "/me/devices")
    );
    expect(
      phoneView.filter((device) => device.current).map((device) => device.id)
    ).toEqual([phone.id]);

    const fromAlice = await call(app, aliceKey.token, "GET", "/me/devices");
    expect(fromAlice.json()).toEqual({
      devices: [
        {
          addedAt: aliceKey.addedAt,
          current: true,
          id: aliceKey.id,
          label: "Alice phone",
          lastUsedAt: expect.any(String),
        },
      ],
    });
  } finally {
    await cleanup();
  }
});

test("a Person revokes their other device and that key stops working", async () => {
  const { app, cleanup, laptop, phone } = await setup();
  try {
    const revoked = await call(
      app,
      laptop.token,
      "DELETE",
      `/me/devices/${phone.id}`
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({
      addedAt: phone.addedAt,
      current: false,
      id: phone.id,
      label: "Phone",
      lastUsedAt: null,
    });
    expect(await statusOf(call(app, phone.token, "GET", "/me"))).toBe(401);
    const listed = await devicesOf(
      call(app, laptop.token, "GET", "/me/devices")
    );
    expect(listed.map((device) => device.id)).toEqual([laptop.id]);
    const again = await call(
      app,
      laptop.token,
      "DELETE",
      `/me/devices/${phone.id}`
    );
    expect(again.statusCode).toBe(404);
  } finally {
    await cleanup();
  }
});

test("revoking the current device signs it out", async () => {
  const { app, cleanup, laptop, phone } = await setup();
  try {
    const revoked = await call(
      app,
      laptop.token,
      "DELETE",
      `/me/devices/${laptop.id}`
    );
    expect(revoked.statusCode).toBe(200);
    expect(decodeDevice(revoked.json()).current).toBe(true);
    expect(await statusOf(call(app, laptop.token, "GET", "/me/devices"))).toBe(
      401
    );
    expect(await statusOf(call(app, phone.token, "GET", "/me"))).toBe(200);
  } finally {
    await cleanup();
  }
});

test("a Person cannot revoke another Person's key or an admin key", async () => {
  const { admin, aliceKey, app, cleanup, laptop } = await setup();
  try {
    const otherPerson = await call(
      app,
      laptop.token,
      "DELETE",
      `/me/devices/${aliceKey.id}`
    );
    const missing = await call(
      app,
      laptop.token,
      "DELETE",
      "/me/devices/does-not-exist"
    );
    expect(otherPerson.statusCode).toBe(404);
    expect(otherPerson.json()).toEqual(missing.json());
    expect(await statusOf(call(app, aliceKey.token, "GET", "/me"))).toBe(200);

    const adminKey = await call(
      app,
      laptop.token,
      "DELETE",
      `/me/devices/${admin.id}`
    );
    expect(adminKey.statusCode).toBe(404);
    expect(await statusOf(call(app, admin.token, "GET", "/admin/keys"))).toBe(
      200
    );
  } finally {
    await cleanup();
  }
});

test("the Devices routes need a daily key", async () => {
  const { admin, app, cleanup, phone } = await setup();
  try {
    const statuses = await Promise.all([
      call(app, null, "GET", "/me/devices"),
      call(app, null, "DELETE", `/me/devices/${phone.id}`),
      call(app, "not-a-key", "GET", "/me/devices"),
      call(app, "not-a-key", "DELETE", `/me/devices/${phone.id}`),
      call(app, admin.token, "GET", "/me/devices"),
      call(app, admin.token, "DELETE", `/me/devices/${phone.id}`),
      request(app, { method: "GET", url: "/me/devices" }),
      request(app, { method: "DELETE", url: `/me/devices/${phone.id}` }),
    ]);
    expect(statuses.map((response) => response.statusCode)).toEqual([
      403, 403, 401, 401, 403, 403, 403, 403,
    ]);
    expect(await statusOf(call(app, phone.token, "GET", "/me"))).toBe(200);
  } finally {
    await cleanup();
  }
});
