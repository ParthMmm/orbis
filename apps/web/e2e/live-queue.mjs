// The player and the Listening Queue through the built web client against a real
// Orbis API (e2e/api-server.ts): stream grants, Playback Position, the live queue,
// reconnecting after the API restarts, and moving on when a Set ends.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-player");
const devicePort = 4511;
const webPort = 3411;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const key = randomBytes(24).toString("base64url");
const otherKey = randomBytes(24).toString("base64url");

const waitFor = async (url) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(url);
      return;
    } catch {
      // Not listening yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error(`${url} did not start`);
};

// The same Person from a second client, as another device would call the API.
const api = async (method, route, body, token = key) => {
  const init = {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  assert.ok(response.ok, `${method} ${route} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
};

const waitUntil = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(200);
  }
  throw new Error(message);
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-player-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "other-key",
        label: "Other Person",
        lastUsedAt: null,
        personId: "other",
        scope: "daily",
        tokenHash: createHash("sha256").update(otherKey).digest("hex"),
      },
      {
        addedAt: new Date().toISOString(),
        id: "journey-key",
        label: "Player journey",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(key).digest("hex"),
      },
    ],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
      { autoDownload: false, id: "other", removed: false, username: "other" },
    ],
    version: 2,
  })
);
const startApi = () =>
  spawn("bun", ["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: dataDirectory,
      ORBIS_FIXTURE_ORIGIN: webUrl,
      ORBIS_FIXTURE_PORT: String(devicePort),
    },
    stdio: "ignore",
  });
let server = startApi();
const web = spawn(
  "bun",
  [
    "x",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
    "--strictPort",
  ],
  {
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });

  // Two Sets with kept audio, saved from "another device".
  const sets = {};
  for (const [name, link] of [
    ["First set", "https://www.youtube.com/watch?v=aaaaaaaaaaa"],
    ["Second set", "https://www.youtube.com/watch?v=bbbbbbbbbbb"],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const saved = await api("POST", "/sets", { url: link });
    // eslint-disable-next-line no-await-in-loop
    await api("PATCH", `/sets/${saved.id}/title`, { title: name });
    // eslint-disable-next-line no-await-in-loop
    await api("POST", `/sets/${saved.id}/audio/download`);
    sets[name] = saved.id;
  }
  await waitUntil(async () => {
    const { sets: library } = await api("GET", "/sets");
    return library.every((set) => set.downloadState === "ready");
  }, "the Downloads did not finish");
  step("two Sets with kept audio are in the Library");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const violations = [];
    const eventRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      assert.ok(!url.search.includes(key));
      if (url.pathname === "/events") {
        assert.equal(url.search, "?changes=1");
        assert.equal(request.headers().authorization, `Bearer ${key}`);
        eventRequests.push({ bearerHeader: true, path: "/events" });
      }
    });
    await page.exposeFunction("reportViolation", (text) =>
      violations.push(text)
    );
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        window.reportViolation(
          `${event.violatedDirective} ${event.blockedURI}`
        );
      });
    });
    const positionReports = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/position")) {
        positionReports.push(response.status());
      }
    });
    const audio = page.getByRole("region", { name: "Audio player" });
    const audioState = () =>
      page.evaluate(() => {
        const element = document.querySelector("audio");
        return element
          ? {
              currentTime: element.currentTime,
              paused: element.paused,
              src: element.currentSrc,
            }
          : null;
      });

    await page.goto(`${webUrl}/sign-in`);
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { exact: true, name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();

    await page.getByRole("button", { name: "Actions for First set" }).click();
    await page.getByRole("menuitem", { exact: true, name: "Play" }).click();
    await audio.getByText("First set").waitFor();
    await waitUntil(async () => {
      const state = await audioState();
      return state !== null && !state.paused && state.currentTime > 0.3;
    }, "the audio did not start");
    const started = await audioState();
    assert.match(
      started.src,
      new RegExp(`^${apiUrl}/sets/${sets["First set"]}/audio\\?grant=`, "u")
    );
    await page.screenshot({ path: path.join(artifacts, "playing.png") });
    step("Play streams the Set from the API through a stream grant");

    await page.evaluate(() => {
      const element = document.querySelector("audio");
      if (element) {
        element.currentTime = 5;
        element.pause();
      }
    });
    await waitUntil(
      async () => {
        const { sets: library } = await api("GET", "/sets");
        const first = library.find((set) => set.id === sets["First set"]);
        return first.playbackPositionSeconds > 0;
      },
      `pausing did not report the Playback Position: ${JSON.stringify(positionReports)}`
    );
    step("pausing saves the Playback Position on the server");
    let failAudio = true;
    let grants = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/audio/grant")) {
        grants += 1;
      }
    });
    await page.route("**/audio?grant=*", (route) => {
      if (failAudio) {
        failAudio = false;
        return route.abort("failed");
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Actions for First set" }).click();
    await page.getByRole("menuitem", { exact: true, name: "Play" }).click();
    await audio.getByText("The audio could not load.").waitFor();
    const beforeRetry = grants;
    await audio.getByRole("button", { name: "Retry audio" }).click();
    await waitUntil(async () => {
      const state = await audioState();
      return state !== null && !state.paused && state.currentTime >= 4.5;
    }, "retry did not resume the caller's Playback Position");
    assert.equal(grants, beforeRetry + 1);
    await page.unroute("**/audio?grant=*");
    await page.screenshot({
      path: path.join(artifacts, "retried-at-saved-position.png"),
    });
    step(
      "Retry audio obtains a fresh grant and resumes the caller's saved position"
    );

    await page.getByRole("button", { name: "Actions for Second set" }).click();
    await page.getByRole("menuitem", { name: "Add to queue" }).click();
    await page.getByRole("link", { name: "Queue" }).click();
    const queue = page.getByRole("region", { name: "Listening queue" });
    await queue.getByText("Now: First set").waitFor();
    await queue.getByRole("button", { name: "Play Second set" }).waitFor();
    step("Add to queue puts the Set after the one playing");
    const privateSet = await api(
      "POST",
      "/sets",
      {
        title: "Private other music",
        url: "https://www.youtube.com/watch?v=ccccccccccc",
      },
      otherKey
    );
    await api(
      "POST",
      `/sets/${privateSet.id}/audio/download`,
      undefined,
      otherKey
    );
    await waitUntil(async () => {
      const state = await api(
        "GET",
        `/sets/${privateSet.id}/audio/state`,
        undefined,
        otherKey
      );
      return state.state === "ready";
    }, "the private Download did not finish");
    await api("PUT", "/queue/active", { setId: privateSet.id }, otherKey);
    await page.waitForTimeout(300);
    assert.equal(await queue.getByText("Private other music").count(), 0);
    const remotePlaylist = await api("POST", "/playlists", {
      name: "Remote playlist",
    });
    await api("PUT", `/playlists/${remotePlaylist.id}/sets`, {
      setIds: [sets["First set"], sets["Second set"]],
    });
    await api("PUT", "/queue/playlist", { playlistId: remotePlaylist.id });
    await queue.getByText("Now: First set").waitFor();
    await queue.getByRole("button", { name: "Play Second set" }).waitFor();
    assert.ok(eventRequests.length > 0);
    step(
      "remote Playlist enqueue arrives through bearer-authenticated events and another Person's queue stays hidden"
    );

    await api("PUT", "/queue/active", { setId: sets["Second set"] });
    await queue.getByText("Now: Second set").waitFor();
    await page.screenshot({
      path: path.join(artifacts, "queue-from-other-client.png"),
    });
    step("a change from another client shows without a reload");

    server.kill("SIGTERM");
    await page.getByText("Reconnecting…").waitFor();
    server = startApi();
    await waitFor(`${apiUrl}/health`);
    await api("PUT", "/queue/active", { setId: sets["First set"] });
    await queue.getByText("Now: First set").waitFor({ timeout: 15_000 });
    await page.getByText("Reconnecting…").waitFor({ state: "hidden" });
    await page.screenshot({
      path: path.join(artifacts, "queue-after-reconnect.png"),
    });
    step("the queue reconnects after the API restarts");

    await page.evaluate(() => {
      const element = document.querySelector("audio");
      if (element) {
        element.currentTime = Math.max(0, element.duration - 0.3);
        void element.play();
      }
    });
    await audio.getByText("Second set").waitFor({ timeout: 15_000 });
    await waitUntil(async () => {
      const state = await audioState();
      return state?.src.includes(`/sets/${sets["Second set"]}/audio`);
    }, "the next Set did not start");
    const { queue: after } = await api("GET", "/queue");
    assert.equal(after.activeSetId, sets["Second set"]);
    step("when a Set ends, the next one in the queue plays");

    assert.deepEqual(violations, []);
    step("no Content Security Policy violations");
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `player journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  server.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
