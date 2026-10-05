import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-playlists");
const devicePort = 4491;
const webPort = 3391;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const keys = {
  bob: randomBytes(24).toString("base64url"),
  host: randomBytes(24).toString("base64url"),
};
const setIds = {};
const sets = [
  { title: "Alpha", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
  { title: "Bravo", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
  { title: "Charlie", url: "https://www.youtube.com/watch?v=ccccccccccc" },
];

const waitFor = async (url) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(url).catch(() => null);
    if (response !== null) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error(`${url} did not start`);
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-playlists-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: Object.entries(keys).map(([personId, key]) => ({
      addedAt: new Date().toISOString(),
      id: `${personId}-key`,
      label: "Playlists journey",
      lastUsedAt: null,
      personId,
      scope: "daily",
      tokenHash: createHash("sha256").update(key).digest("hex"),
    })),
    people: [
      {
        autoDownload: false,
        id: "alice",
        removed: false,
        social: true,
        username: "alice",
      },
      {
        autoDownload: false,
        id: "host",
        removed: false,
        social: true,
        username: "host",
      },
      {
        autoDownload: false,
        id: "bob",
        removed: false,
        social: true,
        username: "bob",
      },
    ],
    version: 2,
  })
);
const api = spawn("bun", ["apps/web/e2e/api-server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_DATA_DIR: dataDirectory,
    ORBIS_FIXTURE_ORIGIN: webUrl,
    ORBIS_FIXTURE_PORT: String(devicePort),
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
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

const order = async (page) => {
  const labels = await page
    .getByRole("list", { name: "Sets in this Playlist" })
    .getByRole("button", { name: /^Move .+ up$/u })
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))
    );
  return labels.map((label) => label.slice("Move ".length, -" up".length));
};

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });

  for (const set of sets) {
    // eslint-disable-next-line no-await-in-loop
    const saved = await fetch(`${apiUrl}/sets`, {
      body: JSON.stringify(set),
      headers: {
        authorization: `Bearer ${keys.host}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(saved.status, 201);
    // eslint-disable-next-line no-await-in-loop
    const { id } = await saved.json();
    setIds[set.title] = id;
    if (set.title !== "Alpha") {
      // eslint-disable-next-line no-await-in-loop
      const download = await fetch(`${apiUrl}/sets/${id}/audio/download`, {
        headers: { authorization: `Bearer ${keys.host}` },
        method: "POST",
      });
      assert.equal(download.status, 202);
    }
  }
  step("the Host has three Sets", { titles: sets.map((set) => set.title) });

  const browser = await chromium.launch({ headless: true });
  try {
    const violations = [];
    const openBrowser = async (who) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.exposeFunction("reportViolation", (text) =>
        violations.push(`${who}: ${text}`)
      );
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.reportViolation(
            `${event.violatedDirective} ${event.blockedURI}`
          );
        });
      });
      await page.goto(`${webUrl}/sign-in`);
      await page.getByLabel("API key").fill(keys[who]);
      await page.getByRole("button", { exact: true, name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Library" }).waitFor();
      return page;
    };
    const expectOrder = async (page, titles) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const current = await order(page);
        if (JSON.stringify(current) === JSON.stringify(titles)) {
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await setTimeout(100);
      }
      assert.deepEqual(await order(page), titles);
    };
    const shot = (page, name) =>
      page.screenshot({ fullPage: true, path: path.join(artifacts, name) });

    const host = await openBrowser("host");
    await host
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playlists" })
      .click();
    await host.getByRole("heading", { name: "Playlists" }).waitFor();
    await host.getByText("You have no Playlists yet.").waitFor();
    step("the Playlists page opens from the header");

    await host.getByLabel("Playlist name").fill("Evening");
    await host.getByRole("button", { name: "Create Playlist" }).click();
    await host.getByRole("heading", { exact: true, name: "Evening" }).waitFor();
    await host.getByText("This Playlist has no Sets yet.").waitFor();
    const playlistUrl = host.url();
    assert.match(playlistUrl, /\/playlists\/[^/]+$/u);
    step("creating Evening opens its page", { playlistUrl });

    await host.getByRole("button", { name: "Add Sets…" }).click();
    const picker = host.getByRole("dialog");
    for (const { title } of sets) {
      // eslint-disable-next-line no-await-in-loop
      await picker.getByRole("checkbox", { name: title }).click();
    }
    await picker.getByRole("button", { name: "Add 3 Sets" }).click();
    await expectOrder(host, ["Alpha", "Bravo", "Charlie"]);
    await picker.waitFor({ state: "detached" });
    step("adding three Sets from the Library keeps the picked order");

    await host.getByRole("button", { name: "Move Charlie up" }).click();
    await expectOrder(host, ["Alpha", "Charlie", "Bravo"]);
    await host.getByRole("button", { name: "Move Alpha down" }).click();
    await expectOrder(host, ["Charlie", "Alpha", "Bravo"]);
    assert.equal(
      await host.getByRole("button", { name: "Move Charlie up" }).isDisabled(),
      true
    );
    step("Move up and Move down reorder the Sets");

    await host
      .getByRole("button", { name: "Remove Alpha from Evening" })
      .click();
    await expectOrder(host, ["Charlie", "Bravo"]);
    step("removing a Set takes it out of the Playlist");

    await host.getByRole("button", { name: "Rename…" }).click();
    await host.getByLabel("Playlist name").fill("Late night");
    await host
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Save" })
      .click();
    await host.getByRole("dialog").waitFor({ state: "detached" });
    await host
      .getByRole("heading", { exact: true, name: "Late night" })
      .waitFor();
    step("rename changes the Playlist's name");

    await host.reload();
    await host
      .getByRole("heading", { exact: true, name: "Late night" })
      .waitFor();
    await expectOrder(host, ["Charlie", "Bravo"]);
    await host.goto(`${webUrl}/`);
    await host.getByRole("heading", { name: "Library" }).waitFor();
    await host.goto(playlistUrl);
    await host
      .getByRole("heading", { exact: true, name: "Late night" })
      .waitFor();
    await expectOrder(host, ["Charlie", "Bravo"]);
    await shot(host, "playlist.png");
    step("a reload and a deep link open the same Playlist");
    const playPlaylist = async (page, who, titles) => {
      await page
        .getByRole("button", { exact: true, name: "Play Playlist" })
        .click();
      const player = page.getByRole("region", { name: "Audio player" });
      await player.waitFor();
      await page.waitForFunction((id) => {
        const audio = document.querySelector("audio");
        return (
          audio !== null &&
          audio.currentSrc.includes(`/sets/${id}/audio`) &&
          !audio.paused &&
          audio.currentTime > 0
        );
      }, setIds[titles[0]]);
      const response = await fetch(`${apiUrl}/queue`, {
        headers: { authorization: `Bearer ${keys[who]}` },
      });
      assert.equal(response.status, 200);
      const { queue } = await response.json();
      assert.deepEqual(
        queue.entries.map((entry) => entry.id),
        titles.map((title) => setIds[title])
      );
      assert.equal(queue.activeSetId, queue.entries[0].id);
      await shot(page, `${who}-playing-playlist.png`);
      await page.evaluate(() => document.querySelector("audio")?.pause());
    };
    await playPlaylist(host, "host", ["Charlie", "Bravo"]);
    step(
      "the creator plays the Playlist in order through real audio and the server queue"
    );

    const collaborative = host.getByRole("switch", { name: "Collaborative" });
    assert.equal(await collaborative.isChecked(), false);
    await collaborative.click();
    await host.getByText("No editors yet.").waitFor();
    await host.getByLabel("Add editor").selectOption({ label: "bob" });
    await host.getByRole("button", { name: "Add editor" }).click();
    await host
      .getByRole("list", { name: "Editors" })
      .getByText("bob", { exact: true })
      .waitFor();
    assert.equal(await collaborative.isChecked(), true);
    await shot(host, "collaborative.png");
    step("the creator makes it Collaborative and adds bob as an editor");

    const bob = await openBrowser("bob");
    await bob.goto(`${webUrl}/playlists`);
    const shared = bob.getByRole("list", { name: "Shared with you" });
    await shared.getByText("host · 2 Sets").waitFor();
    await shared.getByRole("link", { name: /Late night/u }).click();
    await bob
      .getByRole("heading", { exact: true, name: "Late night" })
      .waitFor();
    await bob.getByText(/Shared by host/u).waitFor();
    await expectOrder(bob, ["Charlie", "Bravo"]);
    assert.equal(await bob.getByRole("button", { name: "Rename…" }).count(), 0);
    assert.equal(await bob.getByRole("button", { name: "Delete…" }).count(), 0);
    assert.equal(await bob.getByRole("switch").count(), 0);
    assert.equal(
      await bob.getByRole("heading", { name: "Collaboration" }).count(),
      0
    );
    await bob.getByRole("button", { name: "Move Bravo up" }).click();
    await expectOrder(bob, ["Bravo", "Charlie"]);
    await shot(bob, "editor.png");
    step("bob, an editor, reorders but sees no rename, delete, or settings");
    await playPlaylist(bob, "bob", ["Bravo", "Charlie"]);
    step("an editor plays the shared Playlist in its new order");

    await host.reload();
    await expectOrder(host, ["Bravo", "Charlie"]);
    step("the creator sees the editor's order");

    const expectRequestRecovery = async ({
      page,
      name,
      endpoint,
      url,
      recovered,
    }) => {
      let failedRequests = 0;
      await page.route(endpoint, async (route) => {
        failedRequests += 1;
        const response = await route.fetch();
        await route.fulfill({ body: "", response, status: 503 });
      });
      await page.goto(url);
      const alert = page.getByRole("alert").filter({
        hasText: "Orbis could not complete the request. Try again.",
      });
      await alert.waitFor();
      await page.getByRole("button", { name: "Try again" }).waitFor();
      assert.ok(failedRequests > 0, `${name} request must fail`);
      await shot(page, `${name}-failed.png`);
      step(`${name} request fails`, { failedRequests });
      await page.unroute(endpoint);
      await page.getByRole("button", { name: "Try again" }).click();
      await recovered();
      assert.equal(await alert.count(), 0);
      await shot(page, `${name}-recovered.png`);
      step(`${name} request recovers`);
    };
    await expectRequestRecovery({
      endpoint: `${apiUrl}/playlists/shared`,
      name: "shared-playlists",
      page: bob,
      recovered: () =>
        bob
          .getByRole("list", { name: "Shared with you" })
          .getByRole("link", { name: /Late night/u })
          .waitFor(),
      url: `${webUrl}/playlists`,
    });
    await expectRequestRecovery({
      endpoint: `${apiUrl}/sets`,
      name: "playlist-library",
      page: host,
      recovered: async () => {
        await expectOrder(host, ["Bravo", "Charlie"]);
        await host.getByRole("button", { name: "Add Sets…" }).click();
        await host
          .getByRole("dialog")
          .getByRole("checkbox", { name: "Alpha" })
          .waitFor();
        await host.keyboard.press("Escape");
      },
      url: playlistUrl,
    });
    await expectRequestRecovery({
      endpoint: `${apiUrl}${new URL(playlistUrl).pathname}/collaboration`,
      name: "playlist-collaboration",
      page: host,
      recovered: async () => {
        await host.getByRole("switch", { name: "Collaborative" }).waitFor();
        assert.equal(await collaborative.isChecked(), true);
        await host
          .getByRole("list", { name: "Editors" })
          .getByText("bob", { exact: true })
          .waitFor();
      },
      url: playlistUrl,
    });
    await expectRequestRecovery({
      endpoint: `${apiUrl}/people`,
      name: "playlist-people",
      page: host,
      recovered: async () => {
        await host
          .getByRole("list", { name: "Editors" })
          .getByText("bob", { exact: true })
          .waitFor();
        await host.getByLabel("Add editor").selectOption({ label: "alice" });
      },
      url: playlistUrl,
    });

    await host
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Library" })
      .click();
    await host.getByRole("heading", { name: "Library" }).waitFor();
    await host.getByRole("button", { name: "Actions for Alpha" }).click();
    await host.getByRole("menuitem", { name: "Add to Playlist…" }).click();
    const chooser = host.getByRole("dialog");
    const lateNight = chooser.getByRole("checkbox", { name: "Late night" });
    assert.equal(await lateNight.isChecked(), false);
    await lateNight.click();
    await shot(host, "add-to-playlist.png");
    await chooser.getByRole("button", { exact: true, name: "Save" }).click();
    await chooser.waitFor({ state: "detached" });
    await host.goto(playlistUrl);
    await expectOrder(host, ["Bravo", "Charlie", "Alpha"]);
    step("the Library's Add to Playlist puts a Set at the end");
    await playPlaylist(host, "host", ["Bravo", "Charlie"]);
    step("Play Playlist skips a Set without Retained Audio");

    await host.getByRole("button", { name: "Delete…" }).click();
    await host
      .getByRole("alertdialog")
      .getByRole("button", { name: "Keep" })
      .click();
    await host
      .getByRole("heading", { exact: true, name: "Late night" })
      .waitFor();
    await host.getByRole("button", { name: "Delete…" }).click();
    await host
      .getByRole("alertdialog")
      .getByRole("button", { exact: true, name: "Delete" })
      .click();
    await host.getByText("You have no Playlists yet.").waitFor();
    assert.equal(new URL(host.url()).pathname, "/playlists");
    await bob.goto(`${webUrl}/playlists`);
    await bob.getByRole("heading", { name: "Playlists" }).waitFor();
    assert.equal(
      await bob.getByRole("list", { name: "Shared with you" }).count(),
      0
    );
    await bob.goto(playlistUrl);
    await bob
      .getByText("This Playlist does not exist, or you cannot open it.")
      .waitFor();
    await shot(host, "deleted.png");
    step("delete, after confirming, removes it for the creator and editor");

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
    `playlists journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
