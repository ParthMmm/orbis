import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { listenerPorts, startListeners } from "./listeners.js";

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-listeners-"));
  const token = crypto.randomUUID();
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      devices: [
        {
          addedAt: new Date().toISOString(),
          id: "fixture",
          label: "Fixture",
          tokenHash: hashToken(token),
        },
      ],
      version: 1,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  return { app, devicesPath, directory, token };
};

const probe = (port = 0) =>
  Bun.serve({
    fetch: () => new Response("probe"),
    hostname: "127.0.0.1",
    port,
  });

/** A listener that never reported its port cannot be rebound or requested. */
const boundPort = (server: { readonly port: number | undefined }): number => {
  if (server.port === undefined) {
    throw new Error("Listener did not report a bound port");
  }
  return server.port;
};

const status = async (
  server: { readonly url: URL },
  headers: HeadersInit = {}
): Promise<number> => {
  const response = await fetch(new URL("/health", server.url), { headers });
  await response.text();
  return response.status;
};

test("separate loopback listeners authenticate devices and share one library", async () => {
  const { app, devicesPath, directory, token } = await fixture();
  let listeners: Awaited<ReturnType<typeof startListeners>> | undefined;
  let disposals = 0;
  try {
    listeners = await startListeners(
      {
        dispose: async () => {
          disposals += 1;
          await app.dispose();
        },
        handler: app.handler,
      },
      { devicePort: 0, localPort: 0 }
    );
    const { device, local } = listeners;
    if (device === undefined) {
      throw new Error("Missing device listener");
    }
    expect(local.hostname).toBe("127.0.0.1");
    expect(device.hostname).toBe("127.0.0.1");
    expect(device.port).not.toBe(local.port);
    const headers = { authorization: `Bearer ${token}` };
    const loopbackHosts = [
      "localhost",
      "127.0.0.1",
      "localhost:4310",
      "127.0.0.1:4310",
    ];

    const localOpen = await status(local);
    expect(localOpen).toBe(200);

    // A spoofed loopback Host must not reach the token-free rule on device ingress.
    const spoofed = await Promise.all(
      loopbackHosts.map((host) => status(device, { host }))
    );
    expect(spoofed).toEqual(loopbackHosts.map(() => 403));

    const invalidTokens = await Promise.all(
      loopbackHosts.map((host) =>
        status(device, { authorization: "Bearer invalid", host })
      )
    );
    expect(invalidTokens).toEqual(loopbackHosts.map(() => 401));

    const invalidLocal = await status(local, {
      authorization: "Bearer invalid",
    });
    expect(invalidLocal).toBe(401);

    const paired = await status(device, headers);
    expect(paired).toBe(200);

    const browserOrigin = await status(device, { ...headers, origin: "null" });
    expect(browserOrigin).toBe(403);

    const saved = await fetch(new URL("/sets", local.url), {
      body: JSON.stringify({
        tags: [],
        title: "Listener fixture",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(saved.status).toBe(201);
    await saved.text();

    const library = await fetch(new URL("/sets", device.url), { headers });
    expect(library.status).toBe(200);
    expect(await library.json()).toMatchObject({
      sets: [{ title: "Listener fixture" }],
    });

    const oversize = (
      server: { readonly url: URL },
      size: number,
      suffix: string
    ) => {
      // Trailing spaces keep the JSON valid while the socket sees the exact size.
      const body = JSON.stringify({
        tags: ["limit"],
        title: "Body limit fixture",
        url: `https://www.youtube.com/watch?v=abcdefghi${suffix}`,
      }).padEnd(size, " ");
      expect(Buffer.byteLength(body)).toBe(size);
      return fetch(new URL("/sets", server.url), {
        body,
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      });
    };
    const bodyLimits = await Promise.all(
      [local, device].flatMap((server, listenerIndex) =>
        [65_536, 65_537].map((size, sizeIndex) =>
          oversize(server, size, `${listenerIndex}${sizeIndex}`)
        )
      )
    );
    expect(bodyLimits.map((response) => response.status)).toEqual([
      201, 413, 201, 413,
    ]);
    await Promise.all(bodyLimits.map((response) => response.text()));

    await writeFile(devicesPath, JSON.stringify({ devices: [], version: 1 }));
    const revokedDevice = await status(device, headers);
    expect(revokedDevice).toBe(401);
    const revokedLocal = await status(local);
    expect(revokedLocal).toBe(200);

    const ports = [boundPort(local), boundPort(device)];
    await Promise.all([listeners.stop(), listeners.stop()]);
    expect(disposals).toBe(1);
    // A throwing probe proves each port was released.
    await Promise.all(ports.map((port) => probe(port).stop(true)));
  } finally {
    await listeners?.stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("device listener is disabled by default", async () => {
  const { app, directory } = await fixture();
  let listeners: Awaited<ReturnType<typeof startListeners>> | undefined;
  try {
    expect(listenerPorts({})).toEqual({ localPort: 4310 });
    listeners = await startListeners(app, listenerPorts({ ORBIS_PORT: "0" }));
    expect(listeners.device).toBeUndefined();
    const response = await fetch(new URL("/health", listeners.local.url));
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await listeners?.stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("validates environment ports before binding, with no ephemeral device setting", () => {
  for (const value of [
    "",
    " ",
    "-1",
    "1.5",
    "NaN",
    "65536",
    "Infinity",
    "4310x",
  ]) {
    expect(() => listenerPorts({ ORBIS_PORT: value })).toThrow();
    expect(() => listenerPorts({ ORBIS_DEVICE_PORT: value })).toThrow();
  }
  expect(() => listenerPorts({ ORBIS_DEVICE_PORT: "0" })).toThrow();
  expect(() => listenerPorts({ ORBIS_DEVICE_PORT: "4310" })).toThrow();
  expect(
    listenerPorts({ ORBIS_DEVICE_PORT: "65535", ORBIS_PORT: "0" })
  ).toEqual({ devicePort: 65_535, localPort: 0 });
  expect(listenerPorts({ ORBIS_DEVICE_PORT: "4311", ORBIS_PORT: "1" })).toEqual(
    {
      devicePort: 4311,
      localPort: 1,
    }
  );
});

test("occupied second port closes the first listener and disposes the shared app", async () => {
  const { app, directory } = await fixture();
  const occupied = probe();
  const reservation = probe();
  const localPort = boundPort(reservation);
  await reservation.stop(true);
  let disposals = 0;
  try {
    const startup = startListeners(
      {
        dispose: async () => {
          disposals += 1;
          await app.dispose();
        },
        handler: app.handler,
      },
      { devicePort: boundPort(occupied), localPort }
    );
    await expect(startup).rejects.toThrow();
    expect(disposals).toBe(1);
    await probe(localPort).stop(true);
  } finally {
    await occupied.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});
