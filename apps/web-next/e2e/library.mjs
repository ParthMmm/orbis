// Every Library action through the built web client against a real Orbis API
// (e2e/api-server.ts): save, duplicate save, rename, Tags, filters, search,
// Download, and remove, with screenshots and a result.json as the artifact.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-next-library");
const apiPort = 4470;
const devicePort = 4471;
const webPort = 3371;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const key = randomBytes(24).toString("base64url");
const youTubeLink = "https://www.youtube.com/watch?v=abcdefghijk";
const soundCloudLink = "https://soundcloud.com/artist/track";

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

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-library-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "journey-key",
        label: "Library journey",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(key).digest("hex"),
      },
    ],
    // Auto Download off, so the journey starts the Download itself.
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
    ],
    version: 2,
  })
);
const api = spawn("bun", ["apps/web-next/e2e/api-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_DATA_DIR: dataDirectory,
    ORBIS_DEVICE_PORT: String(devicePort),
    ORBIS_PORT: String(apiPort),
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
    String(webPort),
    "--strictPort",
  ],
  {
    cwd: path.join(root, "apps/web-next"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/health`),
    waitFor(webUrl),
  ]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const violations = [];
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
    const count = page.getByRole("status").filter({ hasText: /^\d+ Sets?$/u });
    const expectCount = async (n) => {
      await count
        .filter({ hasText: `${n} ${n === 1 ? "Set" : "Sets"}` })
        .waitFor();
    };
    const setTitles = () =>
      page
        .getByRole("list", { name: "Sets" })
        .getByRole("heading")
        .allInnerTexts();
    const save = async (link) => {
      await page.getByLabel("Source Link").fill(link);
      await page.getByRole("button", { exact: true, name: "Save" }).click();
    };
    const openAction = async (title, action) => {
      await page.getByRole("button", { name: `Actions for ${title}` }).click();
      await page.getByRole("menuitem", { name: action }).click();
    };

    await page.goto(`${webUrl}/sign-in`);
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { exact: true, name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await expectCount(0);
    await page.getByText("Save a Source Link to start your Library.").waitFor();
    step("an empty Library invites a first save");

    await save(youTubeLink);
    await expectCount(1);
    assert.deepEqual(await setTitles(), ["YouTube video"]);
    step("saving a YouTube link adds a Set");

    await save(youTubeLink);
    await page.getByText("This Set is already in your Library.").waitFor();
    await expectCount(1);
    step("saving the same link again says it is already there");

    await save(soundCloudLink);
    await expectCount(2);
    const titles = await setTitles();
    const soundCloudTitle = titles.find((title) => title !== "YouTube video");
    assert.ok(soundCloudTitle);
    step("saving a SoundCloud link adds a second Set", { soundCloudTitle });

    await openAction("YouTube video", "Rename…");
    await page.getByLabel("Title").fill("Long set");
    await page
      .getByRole("button", { exact: true, name: "Save" })
      .last()
      .click();
    await page.getByRole("heading", { name: "Long set" }).waitFor();
    step("rename changes the title");

    await openAction("Long set", "Edit Tags…");
    await page
      .getByLabel("Tags, separated by commas")
      .fill("house, techno, house");
    await page
      .getByRole("button", { exact: true, name: "Save" })
      .last()
      .click();
    const longSet = page.getByRole("listitem").filter({ hasText: "Long set" });
    await longSet.getByText("house", { exact: true }).waitFor();
    await longSet.getByText("techno", { exact: true }).waitFor();
    step("Tags are saved without repeats");

    await page.getByLabel("Tag", { exact: true }).selectOption("house");
    await expectCount(1);
    assert.deepEqual(await setTitles(), ["Long set"]);
    assert.equal(new URL(page.url()).searchParams.get("tag"), "house");
    await page.screenshot({
      path: path.join(artifacts, "filtered-by-tag.png"),
    });
    await page.getByLabel("Tag", { exact: true }).selectOption("");
    await expectCount(2);
    step("the Tag filter narrows the list and is kept in the URL");

    await page.getByLabel("Source", { exact: true }).selectOption("soundcloud");
    await expectCount(1);
    assert.deepEqual(await setTitles(), [soundCloudTitle]);
    await page.getByLabel("Source", { exact: true }).selectOption("");
    await expectCount(2);
    step("the source filter narrows the list");

    await page.getByLabel("Search library").fill("Long");
    await expectCount(1);
    assert.deepEqual(await setTitles(), ["Long set"]);
    await page.getByLabel("Search library").fill("");
    await expectCount(2);
    step("search narrows the list");

    await openAction("Long set", "Download");
    await longSet.getByText("Audio kept").waitFor({ timeout: 20_000 });
    await page.screenshot({ path: path.join(artifacts, "downloaded.png") });
    step("a Download runs to Audio kept");

    await openAction(soundCloudTitle, "Remove…");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove" })
      .click();
    await expectCount(1);
    assert.deepEqual(await setTitles(), ["Long set"]);
    step("remove, after confirming, takes the Set out of the Library");

    await page.reload();
    await expectCount(1);
    await longSet.getByText("Audio kept").waitFor();
    await longSet.getByText("house", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "after-reload.png") });
    step("everything holds after a reload");

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
    `library journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
