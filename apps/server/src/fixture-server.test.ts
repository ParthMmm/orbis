import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";

test("the disposable HTTP fixture requires its key and accepts one exact Origin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-fixture-http-"));
  const token = crypto.randomUUID();
  await writeFile(
    path.join(directory, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: new Date().toISOString(),
          id: "fixture-admin",
          label: "Disposable HTTP fixture",
          lastUsedAt: null,
          personId: "host",
          scope: "admin",
          tokenHash: hashToken(token),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath: path.join(directory, "devices.json"),
    logging: { silent: true },
  });
  const fixture = await startFixtureServer({
    allowedOrigin: "http://127.0.0.1:3371",
    app,
    port: 0,
    token,
  });
  try {
    const open = await fetch(new URL("/sets", fixture.url));
    expect(open.status).toBe(403);

    const spoofedHost = await fetch(new URL("/sets", fixture.url), {
      headers: { host: "localhost:4310" },
    });
    expect(spoofedHost.status).toBe(403);

    const wrongOrigin = await fetch(new URL("/sets", fixture.url), {
      headers: {
        authorization: `Bearer ${fixture.adminToken}`,
        origin: "http://127.0.0.1:3372",
      },
    });
    expect(wrongOrigin.status).toBe(403);

    const preflight = await fetch(new URL("/sets", fixture.url), {
      headers: {
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-method": "POST",
        origin: "http://127.0.0.1:3371",
      },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3371"
    );

    const keyed = await fetch(new URL("/sets", fixture.url), {
      headers: {
        authorization: `Bearer ${fixture.adminToken}`,
        origin: "http://127.0.0.1:3371",
      },
    });
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3371"
    );
  } finally {
    await fixture.stop();
    await rm(directory, { force: true, recursive: true });
  }
});
