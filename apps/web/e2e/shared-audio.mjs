// Social through the built web client against a real Orbis API (e2e/api-server.ts):
// two People in two browser contexts turn Social on, see each other, watch Presence
// arrive live, open a friend's Library by URL, save and download a friend's Set, use
// See and Appear, and lose sight of each other when one turns Social off (ADR 0009,
// 0010). Screenshots and a result.json are the artifact.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-social");
const apiPort = 4500;
const devicePort = 4501;
const webPort = 3401;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const tokens = {
  alice: randomBytes(24).toString("base64url"),
  bob: randomBytes(24).toString("base64url"),
};
const bobsSetLink = "https://www.youtube.com/watch?v=abcdefghijk";
const bobsOtherLink = "https://soundcloud.com/artist/track";

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

const keyRecord = (personId, token) => ({
  addedAt: new Date().toISOString(),
  id: `${personId}-key`,
  label: `${personId}'s browser`,
  lastUsedAt: null,
  personId,
  scope: "daily",
  tokenHash: createHash("sha256").update(token).digest("hex"),
});

/** One call to the API as a Person, the way another of their devices would. */
const callAs = async (person, method, route, payload) => {
  const headers = { authorization: `Bearer ${tokens[person]}` };
  const init = { headers, method };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiUrl}${route}`, init);
  const body = await response.json();
  assert.ok(
    response.ok,
    `${method} ${route} answered ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
};

const shot = (page, name) =>
  page.screenshot({ fullPage: true, path: path.join(artifacts, name) });
const socialSwitch = (page) =>
  page.getByRole("switch", { exact: true, name: "Social" });
const openPeople = async (page) => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "People" })
    .click();
  await page.getByRole("heading", { name: "People" }).waitFor();
};
const turnSocial = async (page, on) => {
  await socialSwitch(page).click();
  await page
    .locator(`[role="switch"][aria-checked="${on}"]`)
    .and(socialSwitch(page))
    .waitFor();
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-social-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("alice", tokens.alice), keyRecord("bob", tokens.bob)],
    // Social is off for both, as for every new Person. Auto Download is off, so a
    // friend's Set can arrive without audio.
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
    cwd: path.join(root, "apps/web"),
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
    const violations = [];
    const signIn = async (person) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.exposeFunction("reportViolation", (text) =>
        violations.push(`${person}: ${text}`)
      );
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.reportViolation(
            `${event.violatedDirective} ${event.blockedURI}`
          );
        });
      });
      await page.goto(`${webUrl}/sign-in`);
      await page.getByLabel("API key").fill(tokens[person]);
      await page.getByRole("button", { exact: true, name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Library" }).waitFor();
      return page;
    };
    const alice = await signIn("alice");
    const bob = await signIn("bob");
    step("alice and bob sign in, each in their own browser");

    await openPeople(alice);
    await alice
      .getByText("Turn Social on to see the People who turned it on too.")
      .waitFor();
    assert.equal(
      await socialSwitch(alice).getAttribute("aria-checked"),
      "false"
    );
    step("Social is off for a new Person");

    await turnSocial(alice, true);
    await alice.getByText("Nobody else has Social on yet.").waitFor();
    await openPeople(bob);
    await turnSocial(bob, true);
    await bob.getByRole("heading", { name: "alice" }).waitFor();
    await alice.reload();
    const bobRow = alice
      .getByRole("list", { name: "People" })
      .getByRole("listitem")
      .filter({ has: alice.getByRole("heading", { name: "bob" }) });
    await bobRow.getByText("Not listening right now").waitFor();
    await shot(alice, "people.png");
    step("once both turn Social on, alice sees bob in People");

    const bobsSet = await callAs("bob", "POST", "/sets", {
      title: "Bob's set",
      url: bobsSetLink,
    });
    const bobsOther = await callAs("bob", "POST", "/sets", {
      title: "Bob's other set",
      url: bobsOtherLink,
    });
    assert.equal(bobsOther.downloadState, "none");
    const playlist = await callAs("bob", "POST", "/playlists", {
      name: "Late night",
    });
    await callAs("bob", "PUT", `/playlists/${playlist.id}/sets`, {
      setIds: [bobsSet.id, bobsOther.id],
    });
    // Only a Set with audio can be in the queue.
    await callAs("bob", "POST", `/sets/${bobsSet.id}/audio/download`);
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const audio = await callAs(
        "bob",
        "GET",
        `/sets/${bobsSet.id}/audio/state`
      );
      if (audio.state === "ready") {
        break;
      }
      assert.ok(attempt < 100, `bob's Download stuck at ${audio.state}`);
      // eslint-disable-next-line no-await-in-loop
      await setTimeout(200);
    }
    await callAs("bob", "PUT", "/queue/active", { setId: bobsSet.id });
    await callAs("bob", "PUT", `/sets/${bobsSet.id}/position`, {
      seconds: 12,
    });
    step("bob saves two Sets, files them in a Playlist, and starts one");

    // No reload: Presence arrives on the page's one event stream.
    await bobRow.getByText("bob is listening to Bob's set").waitFor();
    await shot(alice, "presence.png");
    step("alice sees bob's Presence live, without reloading");

    await bobRow.getByRole("link", { name: "Open bob’s Library" }).click();
    await alice.waitForURL(`${webUrl}/people/bob`);
    await alice.getByRole("heading", { name: "bob’s Library" }).waitFor();
    const bobsSets = alice.getByRole("list", { name: "bob’s Sets" });
    const setRow = (title) =>
      bobsSets
        .getByRole("listitem")
        .filter({ has: alice.getByRole("heading", { name: title }) });
    await setRow("Bob's set").waitFor();
    await setRow("Bob's other set").waitFor();
    const lateNight = alice.getByRole("region", { name: "Late night" });
    await lateNight.getByText("Bob's set", { exact: true }).waitFor();
    await lateNight.getByText("Bob's other set", { exact: true }).waitFor();
    await alice
      .getByRole("list", { name: "Recent Sets" })
      .getByText("Bob's set")
      .waitFor();
    await alice
      .getByRole("list", { name: "Listen History" })
      .getByText("Listened to Bob's set")
      .waitFor();
    await alice.getByText("bob is listening to Bob's set").waitFor();
    await shot(alice, "profile.png");
    step(
      "bob's profile shows his Library, Playlists, Recent Sets, and Listens"
    );

    await alice.reload();
    await setRow("Bob's set").waitFor();
    step("the profile's URL opens it directly");

    await setRow("Bob's set")
      .getByRole("button", { exact: true, name: "Play Bob's set" })
      .click();
    await alice.waitForFunction(() => {
      const audio = document.querySelector("audio");
      return audio && !audio.paused && audio.currentTime > 0.1;
    });
    const callerPosition = await alice
      .locator("audio")
      .evaluate((audio) => audio.currentTime);
    assert.ok(
      callerPosition < 5,
      `Played bob's position instead of alice's: ${callerPosition}`
    );
    const beforeSaving = await callAs("alice", "GET", "/sets");
    assert.deepEqual(beforeSaving.sets, []);
    await shot(alice, "play-without-saving.png");
    step("playing a shared Set starts at alice's position without saving it", {
      callerPosition,
    });

    await setRow("Bob's set")
      .getByRole("button", { name: "Save Bob's set" })
      .click();
    await setRow("Bob's set")
      .getByRole("button", { exact: true, name: "Saved" })
      .waitFor();
    const mine = await callAs("alice", "GET", "/sets");
    assert.deepEqual(
      mine.sets.map((set) => [set.id, set.titleEditedByUser]),
      [[bobsSet.id, false]]
    );
    step("saving bob's Set adds it to alice's Library, without bob's title", {
      aliceTitle: mine.sets[0].title,
    });

    await setRow("Bob's other set")
      .getByRole("button", { name: "Download Bob's other set" })
      .click();
    await setRow("Bob's other set")
      .getByText("Audio kept")
      .waitFor({ timeout: 20_000 });
    await shot(alice, "saved-and-downloaded.png");
    step("alice downloads bob's Set that had no audio");
    await setRow("Bob's other set")
      .getByRole("button", { exact: true, name: "Play Bob's other set" })
      .click();
    await alice
      .locator(`audio[src*="${bobsOther.id}"]`)
      .waitFor({ state: "attached" });
    await alice.waitForFunction(
      () => document.querySelector("audio")?.paused === false
    );
    await shot(alice, "shared-download-playing.png");
    step("the shared Download becomes playable without saving it");

    await openPeople(alice);
    await bobRow.getByRole("switch", { name: "See bob" }).click();
    await bobRow
      .getByText("Hidden from your People.", { exact: false })
      .waitFor();
    assert.equal(
      await bobRow.getByRole("link", { name: "Open bob’s Library" }).count(),
      0
    );
    await alice.goto(`${webUrl}/people/bob`);
    await alice.getByRole("heading", { name: "Not visible" }).waitFor();
    await openPeople(alice);
    await bobRow.getByRole("switch", { name: "See bob" }).click();
    await bobRow.getByRole("link", { name: "Open bob’s Library" }).waitFor();
    step("See off hides bob from alice until she turns it back on");

    const aliceRow = bob
      .getByRole("list", { name: "People" })
      .getByRole("listitem")
      .filter({ has: bob.getByRole("heading", { name: "alice" }) });
    await aliceRow.getByRole("switch", { name: "Appear to alice" }).click();
    await aliceRow.locator('[role="switch"][aria-checked="false"]').waitFor();
    await alice.reload();
    await alice.getByText("Nobody else has Social on yet.").waitFor();
    await aliceRow.getByRole("switch", { name: "Appear to alice" }).click();
    await aliceRow.locator('[role="switch"][aria-checked="false"]').waitFor({
      state: "detached",
    });
    await alice.reload();
    await bobRow.waitFor();
    step("Appear off hides bob from alice until he turns it back on");

    await turnSocial(bob, false);
    await bob
      .getByText("Turn Social on to see the People who turned it on too.")
      .waitFor();
    // Presence drops live; the list itself loads with the page.
    await bobRow.getByText("Not listening right now").waitFor();
    await alice.reload();
    await alice.getByText("Nobody else has Social on yet.").waitFor();
    await alice.goto(`${webUrl}/people/bob`);
    await alice.getByRole("heading", { name: "Not visible" }).waitFor();
    await shot(alice, "not-visible.png");
    step("when bob turns Social off, alice no longer sees him");

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
    `social journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
