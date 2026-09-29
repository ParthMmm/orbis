import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { createApp } from "../../server/src/app.ts";
import { hashToken } from "../../server/src/identity.ts";
import { startListeners } from "../../server/src/listeners.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const temporary = await mkdtemp(path.join(tmpdir(), "orbis-web-events-"));
const databasePath = path.join(temporary, "db.sqlite");
await writeFile(
  path.join(temporary, "devices.json"),
  JSON.stringify({
    keys: ["a", "b"].map((id) => ({
      addedAt: new Date().toISOString(),
      id,
      label: id,
      lastUsedAt: null,
      personId: id,
      scope: "daily",
      tokenHash: hashToken(`fixture-${id}`),
    })),
    people: ["host", "a", "b"].map((id) => ({
      autoDownload: false,
      id,
      removed: false,
      username: id,
    })),
    version: 2,
  })
);
const service = await startListeners(
  createApp({
    allowDevelopmentOrigins: true,
    databasePath,
    logging: { silent: true },
  }),
  { devicePort: 0, localPort: 0 }
);
const streams = new Set();
const drops = new Set();
let connections = 0;
const proxy = Bun.serve({
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const abort = new AbortController();
      request.signal.addEventListener("abort", () => abort.abort(), {
        once: true,
      });
      const isEvents = url.pathname === "/api/events";
      if (isEvents) {
        streams.add(abort);
        connections += 1;
      }
      const upstream = new URL(
        url.pathname.slice(4) + url.search,
        service.device.url
      );
      const response = await fetch(upstream, {
        body: request.method === "GET" ? undefined : request.body,
        headers: request.headers,
        method: request.method,
        signal: abort.signal,
      });
      const body = isEvents
        ? response.body.pipeThrough(
            new TransformStream({
              start(controller) {
                drops.add(() =>
                  controller.error(new Error("Forced stream drop"))
                );
              },
            })
          )
        : response.body;
      return new Response(body, {
        headers: response.headers,
        status: response.status,
      });
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return new Response(Bun.file(path.join(root, "apps/web/dist", asset)));
  },
  hostname: "127.0.0.1",
  idleTimeout: 60,
  port: 0,
});
const call = async (person, route, method, payload) => {
  const init = {
    headers: {
      authorization: `Bearer fixture-${person}`,
      "content-type": "application/json",
    },
    method,
  };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(new URL(route, service.device.url), init);
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
};
const browser = await chromium.launch({ headless: true });
try {
  const a = await call("a", "/sets", "POST", {
    title: "Remote playlist music",
    url: "https://www.youtube.com/watch?v=queueaaaaaa",
  });
  const b = await call("b", "/sets", "POST", {
    title: "Private other music",
    url: "https://www.youtube.com/watch?v=queuebbbbbb",
  });
  const db = new Database(databasePath);
  db.run(
    "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = 100"
  );
  db.close();
  const playlist = await call("a", "/playlists", "POST", {
    name: "Remote playlist",
  });
  await call("a", `/playlists/${playlist.id}/sets`, "PUT", { setIds: [a.id] });
  const page = await browser.newPage();
  const eventRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/events") {
      assert.equal(new URL(request.url()).search, "");
      assert.equal(request.headers().authorization, "Bearer fixture-a");
      eventRequests.push({ bearerHeader: true, path: "/api/events" });
    }
  });
  await page.goto(proxy.url.href);
  await page.getByLabel("API key").fill("fixture-a");
  await page.getByRole("button", { name: "Connect" }).click();
  const queue = page.getByRole("region", { name: "Listening queue" });
  await queue.getByText("Your queue is empty.").waitFor({ timeout: 5000 });
  await call("b", "/queue/active", "PUT", { setId: b.id });
  await page.waitForTimeout(200);
  assert.equal(await queue.getByText("Private other music").count(), 0);
  await call("a", "/queue/playlist", "PUT", { playlistId: playlist.id });
  await queue.getByText("Remote playlist music").waitFor({ timeout: 3000 });
  const directory = path.join(root, ".cache/queue-events/browser");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(directory, "queue-from-other-client.png"),
  });
  const previousConnections = connections;
  for (const drop of drops) {
    drop();
  }
  drops.clear();
  for (const stream of streams) {
    stream.abort();
  }
  streams.clear();
  await page.waitForFunction(() =>
    document.body.textContent.includes("Reconnecting")
  );
  await call("a", "/queue/completion", "POST", { setId: a.id });
  await queue.getByText("Your queue is empty.").waitFor({ timeout: 8000 });
  assert.ok(connections > previousConnections);
  await page.screenshot({
    fullPage: true,
    path: path.join(directory, "queue-after-reconnect.png"),
  });
  await writeFile(
    path.join(directory, "journey.json"),
    JSON.stringify(
      {
        connections,
        eventRequests,
        otherPersonHidden: true,
        reconnectedToCurrentQueue: true,
        remotePlaylistVisible: true,
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  for (const stream of streams) {
    stream.abort();
  }
  await proxy.stop(true);
  await service.stop();
  await rm(temporary, { force: true, recursive: true });
}
