// A real browser, API, and SQLite database verify the Set page and Cue seek.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-tracklist");
const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "orbis-tracklist-web-")
);
const ports = { api: 4530, device: 4531, web: 3431 };
const apiUrl = `http://127.0.0.1:${ports.device}`;
const webUrl = `http://127.0.0.1:${ports.web}`;
const key = randomBytes(24).toString("base64url");
const steps = [];

const waitFor = async (url) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(url);
      return;
    } catch {
      // The server has not bound its port yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error(`${url} did not start`);
};

const call = async (method, route, payload) => {
  const headers = { authorization: `Bearer ${key}` };
  const init = { headers, method };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  const body = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return body;
};

await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "tracklist-web-key",
        label: "Tracklist web journey",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(key).digest("hex"),
      },
    ],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);

const api = spawn("bun", ["apps/web/e2e/api-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_DATA_DIR: dataDirectory,
    ORBIS_DEVICE_PORT: String(ports.device),
    ORBIS_PORT: String(ports.api),
  },
  stdio: "ignore",
});
const web = spawn(
  "bun",
  [
    "x",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(ports.web),
    "--strictPort",
  ],
  {
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${ports.api}/health`),
    waitFor(webUrl),
  ]);
  await mkdir(artifacts, { recursive: true });
  const saved = await call("POST", "/sets", {
    title: "Tracklist journey Set",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  });
  await call("POST", `/sets/${saved.id}/audio/download`);
  let audioReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const state = await call("GET", `/sets/${saved.id}/audio/state`);
    if (state.state === "ready") {
      audioReady = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(200);
  }
  assert.ok(audioReady, "audio Download did not finish");

  execFileSync("bun", [
    "-e",
    `import { Database } from "bun:sqlite";
     const db = new Database(process.argv[1]);
     db.query("UPDATE sets SET tracklist_state = 'ready' WHERE id = ?").run(process.argv[2]);
     const insert = db.query("INSERT INTO set_cues (set_id, position, start_seconds, artist, title, artwork_url) VALUES (?, ?, ?, ?, ?, ?)");
     insert.run(process.argv[2], 0, 0, "First Artist", "Opening", null);
     insert.run(process.argv[2], 1, 12, "Second Artist", "Middle", null);
     insert.run(process.argv[2], 2, null, "Third Artist", "Untimed", null);
     db.close();`,
    path.join(dataDirectory, "library.sqlite"),
    saved.id,
  ]);
  steps.push("a saved Set has playable audio and three persisted Cues");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${webUrl}/sign-in`);
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await page.getByRole("link", { name: "Tracklist journey Set" }).click();
    await page.waitForURL(`${webUrl}/sets/${saved.id}`);
    const list = page.getByRole("list", { name: "Tracklist" });
    await list
      .getByRole("button", { name: "Middle, Second Artist, starts at 0:12" })
      .waitFor();
    assert.equal(await list.getByRole("listitem").count(), 3);
    assert.equal(await list.getByRole("button").count(), 2);
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "set-tracklist.png"),
    });
    steps.push("Set page shows three Cues; the untimed Cue is not a button");

    await list
      .getByRole("button", { name: "Middle, Second Artist, starts at 0:12" })
      .click();
    const audio = page.locator('audio[data-slot="audio-player-element"]');
    await audio.waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector(
        'audio[data-slot="audio-player-element"]'
      );
      return element && element.currentTime >= 12;
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('ol[aria-label="Tracklist"] button')].some(
        (button) =>
          button.getAttribute("aria-current") === "true" &&
          button.textContent?.includes("Middle")
      )
    );
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "cue-playing.png"),
    });
    steps.push("tapping a Cue seeks audio to 12 seconds and highlights it");

    const opening = list.getByRole("button", {
      name: "Opening, First Artist, starts at 0:00",
    });
    await opening.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const element = document.querySelector(
        'audio[data-slot="audio-player-element"]'
      );
      return element && element.currentTime < 2;
    });
    steps.push("a keyboard user can activate a Cue");

    await page.setViewportSize({ height: 812, width: 375 });
    await page.screenshot({
      fullPage: true,
      path: path.join(artifacts, "phone-tracklist.png"),
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      true
    );
    steps.push("Tracklist fits phone width");
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify({ ok: true, steps }, null, 2)
  );
  console.log(
    `tracklist journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill();
  web.kill();
  await rm(dataDirectory, { force: true, recursive: true });
}
