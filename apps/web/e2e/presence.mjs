// Explicit Presence and the change feed through the built web client against a
// real Orbis API (e2e/api-server.ts). alice plays real fixture audio in one
// browser while bob watches People in another; alice's second browser changes her
// Library and the first shows it without a reload (ADR 0019, #212).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-presence");
const devicePort = 4521;
const webPort = 3421;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const tokens = {
  alice: randomBytes(24).toString("base64url"),
  bob: randomBytes(24).toString("base64url"),
};

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

const waitUntil = async (check, message, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(200);
  }
  throw new Error(message);
};

const keyRecord = (personId, token) => ({
  addedAt: new Date().toISOString(),
  id: `${personId}-key`,
  label: `${personId}'s browser`,
  lastUsedAt: null,
  personId,
  scope: "daily",
  tokenHash: createHash("sha256").update(token).digest("hex"),
});

const callAs = async (person, method, route, payload) => {
  const init = {
    headers: {
      authorization: `Bearer ${tokens[person]}`,
      "content-type": "application/json",
    },
    method,
  };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  assert.ok(response.ok, `${method} ${route} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
};

const shot = (page, name) =>
  page.screenshot({ fullPage: true, path: path.join(artifacts, name) });

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-presence-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("alice", tokens.alice), keyRecord("bob", tokens.bob)],
    people: [
      { id: "host", removed: false, username: "host" },
      { autoDownload: false, id: "alice", removed: false, username: "alice" },
      { autoDownload: false, id: "bob", removed: false, username: "bob" },
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

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });

  await callAs("alice", "PATCH", "/me", { social: true });
  await callAs("bob", "PATCH", "/me", { social: true });
  const set = await callAs("alice", "POST", "/sets", {
    title: "Alice's set",
    url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  });
  await callAs("alice", "POST", `/sets/${set.id}/audio/download`);
  await waitUntil(async () => {
    const audio = await callAs("alice", "GET", `/sets/${set.id}/audio/state`);
    return audio.state === "ready";
  }, "alice's Download did not finish");
  step("alice and bob have Social on, and alice has a Set with kept audio");

  // Chromium plays the fixture headless; autoplay needs no user gesture here.
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
    headless: true,
  });
  try {
    const signIn = async (person) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${webUrl}/sign-in`);
      await page.getByLabel("API key").fill(tokens[person]);
      await page.getByRole("button", { exact: true, name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Library" }).waitFor();
      return page;
    };
    const alice = await signIn("alice");
    const aliceElsewhere = await signIn("alice");
    const bob = await signIn("bob");

    const actions = [];
    const eventQueries = [];
    alice.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/presence/actions") {
        actions.push(request.postDataJSON());
      } else if (url.pathname === "/events") {
        eventQueries.push(url.search);
      }
    });
    const audioState = () =>
      alice.evaluate(() => {
        const element = document.querySelector("audio");
        return element
          ? {
              currentTime: element.currentTime,
              paused: element.paused,
              src: element.currentSrc,
            }
          : null;
      });

    await bob
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "People" })
      .click();
    const aliceRow = bob
      .getByRole("list", { name: "People" })
      .getByRole("listitem")
      .filter({ has: bob.getByRole("heading", { name: "alice" }) });
    await aliceRow.getByText("Not listening right now").waitFor();
    step("bob sees alice in People, not listening");

    let failAudio = true;
    await alice.route("**/audio?grant=*", (route) => {
      if (failAudio) {
        failAudio = false;
        return route.abort("failed");
      }
      return route.continue();
    });
    await alice
      .getByRole("button", { name: "Actions for Alice's set" })
      .click();
    await alice.getByRole("menuitem", { exact: true, name: "Play" }).click();
    const player = alice.getByRole("region", { name: "Audio player" });
    await player.getByText("The audio could not load.").waitFor();
    await alice.waitForTimeout(1000);
    assert.deepEqual(actions, [], "a failed play sent a Presence action");
    assert.equal(
      await aliceRow.getByText("Not listening right now").count(),
      1
    );
    await shot(alice, "a-failed-play.png");
    step("a failed play sends no Presence action, and bob sees none", {
      actions: actions.length,
    });

    await player.getByRole("button", { name: "Retry audio" }).click();
    await waitUntil(async () => {
      const state = await audioState();
      return state !== null && !state.paused && state.currentTime > 0.3;
    }, "the audio did not start");
    await alice.unroute("**/audio?grant=*");
    await waitUntil(
      () => actions.length > 0,
      "playing sent no Presence action"
    );
    assert.equal(actions[0].kind, "play");
    assert.equal(actions[0].setId, set.id);
    await aliceRow.getByText("alice is listening to Alice's set").waitFor();
    await shot(alice, "a-playing.png");
    await shot(bob, "b-sees-presence.png");
    step("bob sees alice's Presence once her audio really plays", {
      action: actions[0].kind,
    });

    await waitUntil(
      () => actions.some((action) => action.kind === "renew"),
      "playing audio did not renew its lease",
      125
    );
    const renew = actions.find((action) => action.kind === "renew");
    assert.equal(renew.sessionId, actions[0].sessionId);
    assert.ok(renew.actionNumber > actions[0].actionNumber);
    step("playing audio renews the lease in the same session");

    await alice.evaluate(() => document.querySelector("audio")?.pause());
    await waitUntil(
      () => actions.some((action) => action.kind === "pause"),
      "pausing sent no Presence action"
    );
    // A Position-inferred Presence would linger for 30 seconds; the pause clears it now.
    await aliceRow
      .getByText("Not listening right now")
      .waitFor({ timeout: 5000 });
    await shot(bob, "b-presence-cleared.png");
    step("bob's view clears when alice pauses", {
      kinds: actions.map((action) => action.kind),
    });

    assert.ok(eventQueries.every((search) => search === "?changes=1"));
    await alice.evaluate(() => {
      window.notReloaded = true;
    });
    const before = await audioState();
    const sets = alice
      .getByRole("list", { name: "Sets" })
      .getByRole("listitem");
    assert.equal(await sets.count(), 1);
    await aliceElsewhere
      .getByLabel("Source Link")
      .fill("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    await aliceElsewhere
      .getByRole("button", { exact: true, name: "Save" })
      .click();
    await waitUntil(
      async () => (await sets.count()) === 2,
      "alice's first browser did not show the new Set"
    );
    assert.equal(await alice.evaluate(() => window.notReloaded), true);
    await shot(aliceElsewhere, "a2-saved-set.png");
    await shot(alice, "a1-library-refreshed.png");
    step(
      "a Set saved in alice's second browser appears in the first without a reload"
    );

    const actionsBefore = actions.length;
    await callAs("alice", "PUT", "/queue/active", { setId: set.id });
    await alice.waitForTimeout(1000);
    const after = await audioState();
    assert.equal(after.src, before.src);
    assert.equal(after.paused, true);
    assert.equal(after.currentTime, before.currentTime);
    assert.equal(actions.length, actionsBefore);
    step("a repeated Queue snapshot leaves the audio alone");
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `presence journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
