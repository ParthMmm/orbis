import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const port = 5181;
const output = path.join(root, ".cache/shared-audio/browser");
const preview = spawn("bun", ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port)], { cwd: path.join(root, "apps/web"), stdio: "ignore" });
const set = {
  artworkLargeUrl: null, artworkUrl: null, createdAt: "2026-01-01T00:00:00.000Z", creator: "DJ", creatorId: null,
  downloadState: "ready", durationSeconds: 30, finishCount: 0, id: "shared-ready", lastListenedAt: null,
  listenCount: 4, metadataState: "enriched", playbackPositionSeconds: 17, playlistIds: [], releasedAt: null,
  retainedAudioBytes: 247269, retainedAudioFormat: "m4a", source: "youtube", tags: ["bob-tag"],
  title: "Bob's title", titleEditedByUser: true, url: "https://www.youtube.com/watch?v=shared00001",
};
const pending = { ...set, id: "shared-download", title: "New Set", downloadState: "none", url: "https://www.youtube.com/watch?v=shared00002" };
const saved = [];
const requests = [];
let queue = { activeSetId: null, entries: [] };
let pendingState = "none";
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) { break; }
    } catch { /* Preview is starting. */ }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const audio = await readFile(path.join(root, "scripts/fixtures/ready-set.m4a"));
  // eslint-disable-next-line complexity -- One browser fixture covers the shared Set's states.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/u, "");
    const payload = request.postDataJSON();
    requests.push({ method: request.method(), pathname });
    const reply = (body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
    if (pathname === "/me") { return reply({ id: "a", username: "Alice", autoDownload: false, social: true }); }
    if (pathname === "/people") { return reply({ people: [{ id: "b", username: "Bob" }] }); }
    if (pathname === "/people/b/sets") { return reply({ sets: [set, { ...pending, downloadState: pendingState }] }); }
    if (pathname === "/tags") { return reply({ tags: [] }); }
    if (pathname === "/playlists") { return reply({ playlists: [] }); }
    if (pathname === "/sets" && request.method() === "POST") {
      assert.equal(payload.url, set.url);
      assert.equal(payload.title, undefined);
      const mine = { ...set, title: "Provider title", tags: [], listenCount: 0, playbackPositionSeconds: 0, titleEditedByUser: false };
      saved.push(mine);
      return reply({ ...mine, autoDownloadResult: "disabled" }, 201);
    }
    if (pathname === "/sets") { return reply({ sets: saved }); }
    if (pathname === "/queue") { return reply({ queue }); }
    if (pathname === "/queue/active") {
      const selected = payload.setId === set.id ? set : pending;
      queue = { activeSetId: selected.id, entries: [{ ...selected, downloadState: "ready", playbackPositionSeconds: 0, listenCount: 1 }] };
      return reply({ queue });
    }
    if (pathname.endsWith("/audio/grant")) { return reply({ url: `${pathname.replace(/\/grant$/u, "")}?grant=fixture` }); }
    if (pathname.endsWith("/audio")) { return route.fulfill({ body: audio, contentType: "audio/mp4", status: 200 }); }
    if (pathname.endsWith("/position")) { return reply({ ...set, playbackPositionSeconds: payload.seconds }); }
    if (pathname.endsWith("/audio/download")) { pendingState = "queued"; return reply({ ...pending, downloadState: pendingState }, 202); }
    if (pathname.endsWith("/audio/state")) { pendingState = "ready"; return reply({ state: "ready", bytesReceived: 247269, bytesTotal: 247269, format: "m4a" }); }
    return reply({ message: "Unexpected route" }, 404);
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel("API key").fill("alice");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Open Bob's Library" }).click();
  const friend = page.locator(".friend-list");
  await friend.getByRole("button", { name: "Play Bob's title", exact: true }).click();
  await page.waitForFunction(() => {
    const player = document.querySelector("audio");
    return player && !player.paused && player.currentTime > 0.1;
  });
  const position = await page.locator("audio").evaluate((player) => player.currentTime);
  assert.ok(position < 5, `Played Bob's position instead of Alice's: ${position}`);
  assert.equal(saved.length, 0);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "play-without-saving.png") });
  await friend.getByRole("button", { name: "Save Bob's title", exact: true }).click();
  await page.getByRole("heading", { name: "Provider title", exact: true }).waitFor();
  await friend.getByRole("button", { name: "Download New Set", exact: true }).click();
  await friend.getByRole("button", { name: "Play New Set", exact: true }).click();
  await page.locator("audio[src*='shared-download']").waitFor();
  await page.waitForFunction(() => document.querySelector("audio")?.paused === false);
  await page.screenshot({ path: path.join(output, "saved-and-shared-download.png") });
  await writeFile(path.join(output, "journey.json"), JSON.stringify({ position, saved: saved.map((item) => ({ id: item.id, title: item.title, tags: item.tags })), pendingState, requests, results: ["play without saving starts at caller position", "one-action save keeps provider title", "visible Download becomes playable"] }, null, 2));
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
}
