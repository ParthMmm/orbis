import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { cutoverHandler } from "./cutover.js";

test("read-only cutover refuses writes and keeps the Library readable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-cutover-"));
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
  });
  const handler = cutoverHandler(app.handler, { kind: "read-only" });
  const server = Bun.serve({
    fetch: (request) => handler(request, "device"),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    await Promise.all(
      ["POST", "PUT", "PATCH", "DELETE"].map(async (method) => {
        const response = await fetch(new URL("/sets", server.url), { method });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("60");
        await response.text();
      })
    );
    const preflight = await fetch(new URL("/sets", server.url), {
      headers: { origin: "https://orbis.p11a.xyz" },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://orbis.p11a.xyz"
    );
    const rejected = await fetch(new URL("/sets", server.url), {
      headers: { origin: "https://orbis.p11a.xyz" },
      method: "POST",
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("access-control-allow-origin")).toBe(
      "https://orbis.p11a.xyz"
    );
    expect(rejected.headers.get("access-control-expose-headers")).toBe(
      "retry-after"
    );
    const response = await handler(
      new Request(new URL("/sets", server.url)),
      "local"
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sets: [] });
  } finally {
    await server.stop(true);
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("forwarding preserves keyed writes, streams, and redirects while audio stays local", async () => {
  const upstream = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/events") {
        return new Response("event: heartbeat\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/api/redirect") {
        return new Response(null, {
          headers: { location: "/api/sets" },
          status: 302,
        });
      }
      if (url.pathname === "/api/compressed") {
        return new Response(Bun.gzipSync("compressed fixture"), {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      return Response.json({
        authorization: request.headers.get("authorization"),
        path: url.pathname,
        payload: await request.text(),
        query: url.search,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const handler = cutoverHandler(
    () => Promise.resolve(new Response("local audio")),
    { apiUrl: new URL("/api", upstream.url), kind: "forward" }
  );
  const server = Bun.serve({
    fetch: (request) => handler(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const response = await fetch(new URL("/sets?tag=techno", server.url), {
      body: JSON.stringify({ title: "Fixture" }),
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(await response.json()).toEqual({
      authorization: "Bearer fixture",
      path: "/api/sets",
      payload: JSON.stringify({ title: "Fixture" }),
      query: "?tag=techno",
    });
    const events = await fetch(new URL("/events", server.url));
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    expect(await events.text()).toContain("event: heartbeat");
    const redirect = await fetch(new URL("/redirect", server.url), {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/api/sets");
    const audio = await fetch(
      new URL("/sets/fixture/audio?grant=fixture", server.url)
    );
    expect(await audio.text()).toBe("local audio");
    const compressed = await fetch(new URL("/compressed", server.url));
    expect(await compressed.text()).toBe("compressed fixture");
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

test("a read-only first read preserves interrupted Download rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-cutover-jobs-"));
  const databasePath = path.join(directory, "library.sqlite");
  const seed = createApp({ databasePath });
  try {
    const saved = await seed.handler(
      new Request("http://localhost/sets", {
        body: JSON.stringify({
          tags: [],
          title: "Fixture",
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(saved.status).toBe(201);
    await saved.text();
  } finally {
    await seed.dispose();
  }
  const database = new Database(databasePath);
  database.run("UPDATE sets SET download_state = 'downloading'");
  const readOnly = createApp({
    audio: { recoverInterruptedDownloads: false, startWorker: false },
    databasePath,
    recordKeyUse: false,
  });
  const handler = cutoverHandler(readOnly.handler, { kind: "read-only" });
  try {
    const response = await handler(new Request("http://localhost/sets"));
    expect(response.status).toBe(200);
    await response.text();
    expect(
      database
        .query<{ download_state: string }, []>(
          "SELECT download_state FROM sets"
        )
        .get()?.download_state
    ).toBe("downloading");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM download_jobs"
        )
        .get()?.count
    ).toBe(0);
  } finally {
    await readOnly.dispose();
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
});
