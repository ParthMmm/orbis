import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WideEvent } from "evlog";

import { createApp } from "./app.js";
import { cutoverHandler } from "./cutover.js";
import { hashToken } from "./identity.js";
import { makeNodeHandler } from "./node-http.js";
import { issueStreamGrant } from "./stream-grant.js";

test("forwarded requests log the authenticated key label at the API without copying trust to the node", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-forwarding-"));
  const devicesPath = path.join(directory, "devices.json");
  const token = crypto.randomUUID();
  await writeFile(
    devicesPath,
    JSON.stringify({
      devices: [
        {
          addedAt: new Date().toISOString(),
          id: "fixture-key",
          label: "Old Apple build",
          tokenHash: hashToken(token),
        },
      ],
      version: 1,
    })
  );
  const events: WideEvent[] = [];
  const forwardedEvents: WideEvent[] = [];
  const app = createApp({
    devicesPath,
    logging: { onEvent: (event) => events.push(event), silent: true },
  });
  const upstream = Bun.serve({
    fetch: (request) => {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice(4);
      return app.handler(new Request(url, request), "device");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const forward = cutoverHandler(
    () => Promise.resolve(new Response(null, { status: 404 })),
    { apiUrl: new URL("/api", upstream.url), kind: "forward" },
    {
      logging: {
        onEvent: (event) => forwardedEvents.push(event),
        silent: true,
      },
    }
  );
  const node = Bun.serve({
    fetch: (request) => forward(request, "device"),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const response = await fetch(new URL("/me", node.url), {
      headers: {
        authorization: `Bearer ${token}`,
        "x-orbis-key-label": "Spoofed label",
      },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(events.find((event) => event.path === "/me")).toMatchObject({
      ingress: "funnel-forward",
      keyLabel: "Old Apple build",
      status: 200,
    });
    expect(forwardedEvents.find((event) => event.path === "/me")).toMatchObject(
      {
        ingress: "funnel-forward",
        keyLabel: "Old Apple build",
        status: 200,
      }
    );
    expect(response.headers.has("x-orbis-key-label")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain("Spoofed label");
  } finally {
    await node.stop(true);
    await upstream.stop(true);
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("an audio node forwards API reads and keeps grant-only Range audio local", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-audio-forwarding-")
  );
  const secret = Buffer.alloc(32, 23);
  await writeFile(
    path.join(directory, "fixture.m4a"),
    Buffer.from("0123456789")
  );
  const upstream = Bun.serve({
    fetch: (request) =>
      Response.json({
        ingress: request.headers.get("x-orbis-ingress"),
        path: new URL(request.url).pathname,
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const node = Bun.serve({
    fetch: makeNodeHandler({
      audioDir: directory,
      logging: { silent: true },
      mode: { apiUrl: new URL("/api", upstream.url), kind: "forward" },
      streamSecret: secret,
    }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const me = await fetch(new URL("/api/me", node.url));
    expect(await me.json()).toEqual({
      ingress: "funnel-forward",
      path: "/api/me",
    });
    const root = await fetch(new URL("/api?probe=1", node.url));
    expect(await root.json()).toEqual({
      ingress: "funnel-forward",
      path: "/api/",
    });
    const denied = await fetch(new URL("/api/sets/fixture/audio", node.url), {
      headers: { authorization: "Bearer client-key" },
    });
    expect(denied.status).toBe(401);
    const url = new URL("/api/sets/fixture/audio", node.url);
    url.searchParams.set("grant", issueStreamGrant(secret, "fixture", "host"));
    const response = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  } finally {
    await node.stop(true);
    await upstream.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});
