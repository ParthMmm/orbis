// The Host invites a new Person against a real Orbis API: the Host adds alice on the
// admin page and creates an Invite, and a second, signed-out browser opens the link,
// names itself, and is signed in as alice with her own daily key (ADR 0016).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

import { readTrustStore } from "./trust-store.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-invite");
const apiPort = 4480;
const devicePort = 4481;
const webPort = 3381;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const dailyKey = randomBytes(24).toString("base64url");
const adminKey = randomBytes(24).toString("base64url");
const deviceLabel = "Alice's laptop";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

// What the API itself says about a key, outside the browser.
const callApi = async (pathname, key) => {
  const response = await fetch(`${apiUrl}${pathname}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { body: await response.json(), status: response.status };
};

const keyRecord = (id, label, key, scope) => ({
  addedAt: new Date().toISOString(),
  id,
  label,
  lastUsedAt: null,
  personId: "host",
  scope,
  tokenHash: sha256(key),
});

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-invite-"));
const devicesPath = path.join(dataDirectory, "devices.json");
await writeFile(
  devicesPath,
  JSON.stringify({
    keys: [
      keyRecord("host-daily", "Host browser", dailyKey, "daily"),
      keyRecord("host-admin", "Host admin", adminKey, "admin"),
    ],
    people: [{ id: "host", removed: false, username: "host" }],
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

const storedKey = (page) =>
  page.evaluate(() => localStorage.getItem("orbis.apiKey"));

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([
    waitFor(`${apiUrl}/health`),
    waitFor(webUrl),
  ]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const violations = [];
    const openContext = async (name, options = {}) => {
      const context = await browser.newContext(options);
      await context.exposeFunction("reportViolation", (text) =>
        violations.push(`${name}: ${text}`)
      );
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          window.reportViolation(
            `${event.violatedDirective} ${event.blockedURI}`
          );
        });
      });
      return context.newPage();
    };
    const host = await openContext("host", {
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const friend = await openContext("friend");
    const selected = host.getByRole("region", { name: "Selected Person" });
    const manage = (username) =>
      host.getByRole("button", { exact: true, name: `Manage ${username}` });

    await host.goto(`${webUrl}/sign-in`);
    await host.getByLabel("API key").fill(dailyKey);
    await host.getByRole("button", { exact: true, name: "Sign in" }).click();
    await host.getByText("Signed in as host").waitFor();
    step("the Host signs in with their daily key");

    await host.goto(`${webUrl}/admin`);
    await host.getByLabel("Admin key").fill(adminKey);
    await host.getByRole("button", { name: "Unlock" }).click();
    await host.getByRole("heading", { name: "People" }).waitFor();
    step("the admin key unlocks the admin page");

    await host.getByLabel("New Person username").fill("alice");
    await host.getByRole("button", { name: "Add Person" }).click();
    await manage("alice").click();
    await selected.getByRole("heading", { name: "alice" }).waitFor();
    const people = await callApi("/admin/people", adminKey);
    const alice = people.body.people.find(
      (person) => person.username === "alice"
    );
    assert.ok(alice);
    step("the Host adds alice", { personId: alice.id });

    await selected.getByRole("button", { name: "Create Invite" }).click();
    const issued = selected.getByRole("status");
    await issued.getByText("Send this Invite link to alice").waitFor();
    const shown = await issued.getByLabel("Invite link").textContent();
    const link = shown.trim();
    assert.match(link, new RegExp(`^${webUrl}/claim#[A-Za-z0-9_-]{40,}$`, "u"));
    const code = link.slice(link.indexOf("#") + 1);
    const storeAfterCreate = JSON.stringify(readTrustStore(dataDirectory));
    assert.ok(!storeAfterCreate.includes(code));
    assert.ok(storeAfterCreate.includes(sha256(code)));
    await issued.getByRole("button", { name: "Copy link" }).click();
    await issued.getByRole("button", { name: "Copied" }).waitFor();
    const copied = await host.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, link);
    await host.screenshot({ path: path.join(artifacts, "host-invite.png") });
    step(
      "the Host creates an Invite and copies its link; the store keeps only its sha256"
    );

    await friend.goto(copied);
    await friend.getByRole("heading", { name: "Join Orbis" }).waitFor();
    assert.equal(await storedKey(friend), null);
    await friend.getByLabel("Device name").fill(deviceLabel);
    await friend.screenshot({ path: path.join(artifacts, "friend-claim.png") });
    await friend.getByRole("button", { exact: true, name: "Sign in" }).click();
    await friend.getByRole("heading", { name: "Library" }).waitFor();
    await friend.getByText("Signed in as alice").waitFor();
    assert.equal(new URL(friend.url()).pathname, "/");
    const friendKey = await storedKey(friend);
    assert.ok(friendKey);
    assert.notEqual(friendKey, dailyKey);
    assert.notEqual(friendKey, adminKey);
    await friend.screenshot({
      path: path.join(artifacts, "friend-signed-in.png"),
    });
    step("a signed-out browser opens the link, names itself, and is alice");

    const me = await callApi("/me", friendKey);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, "alice");
    const store = readTrustStore(dataDirectory);
    const minted = store.keys.find(
      (record) => record.tokenHash === sha256(friendKey)
    );
    assert.equal(minted?.label, deviceLabel);
    assert.equal(minted?.scope, "daily");
    assert.equal(minted?.personId, alice.id);
    assert.ok(!JSON.stringify(store).includes(friendKey));
    const adminRoute = await callApi("/admin/people", friendKey);
    assert.equal(adminRoute.status, 403);
    step(
      "alice's key works on the API and is a daily key named for the device"
    );

    await friend.evaluate(() => localStorage.clear());
    await friend.goto(copied);
    await friend.getByRole("heading", { name: "Join Orbis" }).waitFor();
    await friend.getByRole("button", { exact: true, name: "Sign in" }).click();
    await friend
      .getByRole("alert")
      .getByText("This Invite has already been used.")
      .waitFor();
    assert.equal(
      await friend
        .getByRole("button", { exact: true, name: "Sign in" })
        .count(),
      0
    );
    assert.equal(await storedKey(friend), null);
    await friend.screenshot({
      path: path.join(artifacts, "friend-reused.png"),
    });
    step("reopening the same link fails with a clear message and mints no key");

    const after = readTrustStore(dataDirectory);
    assert.equal(
      after.keys.filter((record) => record.personId === alice.id).length,
      1
    );
    step("alice still has exactly one key");

    assert.deepEqual(violations, []);
    step("no Content Security Policy violations in either browser");
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    `${JSON.stringify({ apiUrl, steps, webUrl }, null, 2)}\n`
  );
  console.log(
    `invite journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
