import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const port = 5178;
const server = spawn(
  "bun",
  ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port)],
  {
    cwd: path.join(root, "apps/web"),
    stdio: "ignore",
  }
);
const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`http://127.0.0.1:${port}`);
      if (response.ok) {
        return;
      }
    } catch {
      // The preview may not be listening yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error("Web preview did not start");
};

const set = {
  artworkLargeUrl: null,
  artworkUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  creator: "DJ",
  creatorId: null,
  downloadState: "ready",
  durationSeconds: 7200,
  finishCount: 0,
  id: "set-a",
  lastListenedAt: null,
  listenCount: 0,
  metadataState: "enriched",
  playbackPositionSeconds: 13,
  playlistIds: [],
  releasedAt: null,
  retainedAudioBytes: 100_000,
  retainedAudioFormat: "m4a",
  source: "youtube",
  tags: ["house"],
  title: "Long set",
  titleEditedByUser: false,
  url: "https://www.youtube.com/watch?v=abcdefghijk",
};
const results = [];
try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const audioBytes = await readFile(
      path.join(root, "scripts/fixtures/ready-set.m4a")
    );
    const page = await browser.newPage();
    let revoked = false;
    let revokeOnNextLibrary = false;
    let grantCount = 0;
    const requests = [];
    const fulfillAudio = async (route, request, grant) => {
      if (grant === "grant-2") {
        await route.fulfill({ body: "Audio unavailable", status: 503 });
        return;
      }
      const range = /^bytes=(?<start>\d+)-(?<end>\d*)$/u.exec(
        request.headers().range ?? ""
      );
      const start = range?.groups ? Number(range.groups.start) : 0;
      const end = range?.groups?.end
        ? Math.min(Number(range.groups.end), audioBytes.length - 1)
        : audioBytes.length - 1;
      const headers = {
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
      };
      if (range) {
        headers["content-range"] = `bytes ${start}-${end}/${audioBytes.length}`;
      }
      await route.fulfill({
        body: audioBytes.subarray(start, end + 1),
        contentType: "audio/mp4",
        headers,
        status: range ? 206 : 200,
      });
    };
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({
        authorization: request.headers().authorization ?? "",
        path: url.pathname,
        payload: request.postDataJSON(),
        query: url.search,
        range: request.headers().range ?? "",
      });
      if (url.pathname.endsWith("/sets") && revokeOnNextLibrary) {
        revokeOnNextLibrary = false;
        revoked = true;
        await route.fulfill({
          body: JSON.stringify({ message: "Invalid key" }),
          contentType: "application/json",
          status: 401,
        });
        return;
      }
      if (
        url.pathname.endsWith("/sets/set-a/audio") &&
        url.searchParams.get("grant")?.startsWith("grant-")
      ) {
        await fulfillAudio(route, request, url.searchParams.get("grant"));
        return;
      }
      const authorized =
        request.headers().authorization === "Bearer good-key" && !revoked;
      if (!authorized) {
        await route.fulfill({
          body: JSON.stringify({ message: "Invalid key" }),
          contentType: "application/json",
          status: 401,
        });
        return;
      }
      let body = set;
      if (url.pathname.endsWith("/me")) {
        body = { autoDownload: true, id: "person-a", username: "A" };
      } else if (url.pathname.endsWith("/sets")) {
        body = { sets: [set] };
      } else if (url.pathname.endsWith("/tags")) {
        body = { tags: ["house"] };
      } else if (url.pathname.endsWith("/audio/grant")) {
        grantCount += 1;
        body = { url: `/sets/set-a/audio?grant=grant-${grantCount}` };
      } else if (url.pathname.endsWith("/queue/active")) {
        body = { queue: { activeSetId: "set-a", entries: [set] } };
      }
      await route.fulfill({
        body: JSON.stringify(body),
        contentType: "application/json",
        status: 200,
      });
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel("API key").fill("bad-key");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("Check your key and try again.").waitFor();
    results.push("bad key explained");

    await page.getByLabel("API key").fill("good-key");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("heading", { name: "Your library" }).waitFor();
    await page.getByRole("heading", { name: "Long set" }).waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("orbis.apiKey")),
      "good-key"
    );
    await page.getByLabel("Search library").fill("long");
    await page.getByLabel("Tag").selectOption("house");
    await page.getByRole("button", { name: "Play Long set" }).click();
    await page.locator("audio[src*='grant=grant-1']").waitFor();
    await page.waitForFunction(
      () => document.querySelector("audio")?.paused === false
    );
    await mkdir(path.join(root, ".cache/web-journey"), { recursive: true });
    await page.screenshot({
      path: path.join(root, ".cache/web-journey/library-and-player.png"),
    });
    assert.ok(
      requests.some((request) => request.path.endsWith("/audio/grant"))
    );
    assert.ok(requests.every((request) => !request.query.includes("good-key")));
    results.push("library search, tag, grant playback, no key in URL");

    await page.waitForFunction(
      () => (document.querySelector("audio")?.readyState ?? 0) >= 1
    );
    await page.locator("audio").evaluate((audio) => {
      audio.currentTime = 20;
    });
    await page.waitForFunction(
      () => Math.abs(document.querySelector("audio")?.currentTime - 20) < 0.5
    );
    await page.waitForTimeout(150);
    assert.ok(
      requests.some(
        (request) =>
          request.path.endsWith("/sets/set-a/position") &&
          request.payload?.seconds >= 19
      )
    );
    assert.ok(
      requests.some(
        (request) =>
          request.path.endsWith("/sets/set-a/audio") &&
          request.range.startsWith("bytes=")
      )
    );
    results.push("seek reports playback position");

    await page.getByRole("button", { name: "Play Long set" }).click();
    await page
      .getByText("Audio could not load. Try again.")
      .waitFor({ timeout: 3000 });
    await page.getByRole("button", { name: "Retry audio" }).click();
    await page.locator("audio[src*='grant=grant-3']").waitFor();
    await page.waitForFunction(
      () => document.querySelector("audio")?.paused === false
    );
    assert.equal(grantCount, 3);
    results.push("failed audio shows retry and gets a fresh grant");

    revokeOnNextLibrary = true;
    await page.getByRole("button", { name: "Refresh library" }).click();
    await page.getByText("Your key was revoked. Enter a new key.").waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("orbis.apiKey")),
      null
    );
    results.push("revoked key returns to entry");
    await page.screenshot({
      path: path.join(root, ".cache/web-journey/revoked.png"),
    });
    await writeFile(
      path.join(root, ".cache/web-journey/result.json"),
      JSON.stringify({ requests, results }, null, 2)
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
