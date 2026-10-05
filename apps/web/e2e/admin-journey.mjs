// The Host manages the Group from the admin page against a real Orbis API: the built
// web client in `vite preview` calls a throwaway server whose trust store holds the
// Host with one daily key and one admin key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-admin");
const apiPort = 4440;
const devicePort = 4441;
const webPort = 3341;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const dailyKey = randomBytes(24).toString("base64url");
const adminKey = randomBytes(24).toString("base64url");

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

// Where the page keeps the admin key: only this tab's sessionStorage.
const storedAdminKey = (target) =>
  target.evaluate(() => ({
    local: localStorage.getItem("orbis.adminKey"),
    session: sessionStorage.getItem("orbis.adminKey"),
  }));

const keyRecord = (id, label, key, scope) => ({
  addedAt: new Date().toISOString(),
  id,
  label,
  lastUsedAt: null,
  personId: "host",
  scope,
  tokenHash: createHash("sha256").update(key).digest("hex"),
});

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-admin-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
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
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const violations = [];
    await context.exposeFunction("reportViolation", (text) =>
      violations.push(text)
    );
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        window.reportViolation(
          `${event.violatedDirective} ${event.blockedURI}`
        );
      });
    });
    const page = await context.newPage();
    const shot = (name) =>
      page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    const unlock = async (value) => {
      await page.getByLabel("Admin key").fill(value);
      await page.getByRole("button", { name: "Unlock" }).click();
    };
    const manage = (username) =>
      page.getByRole("button", { exact: true, name: `Manage ${username}` });
    const selected = page.getByRole("region", { name: "Selected Person" });

    await page.goto(`${webUrl}/sign-in`);
    await page.getByLabel("API key").fill(dailyKey);
    await page.getByRole("button", { exact: true, name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("the Host signs in with their daily key");

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", {
        name: "Admin",
      })
      .click();
    await page.getByRole("heading", { name: "Manage your Group" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/admin");
    await shot("locked");
    step("the Admin link opens the locked admin page");

    await unlock(dailyKey);
    await page
      .getByRole("alert")
      .getByText("An admin key is required.")
      .waitFor();
    assert.deepEqual(await storedAdminKey(page), {
      local: null,
      session: null,
    });
    await unlock("not-a-real-key");
    await page
      .getByRole("alert")
      .getByText("An admin key is required.")
      .waitFor();
    assert.deepEqual(await storedAdminKey(page), {
      local: null,
      session: null,
    });
    await shot("refused");
    step("the daily key and an unknown key are refused and not stored");

    await unlock(adminKey);
    await page.getByRole("heading", { name: "People" }).waitFor();
    await manage("host").waitFor();
    assert.deepEqual(await storedAdminKey(page), {
      local: null,
      session: adminKey,
    });
    step("the admin key unlocks the page and lives in sessionStorage only");

    await page.reload();
    await page.getByRole("heading", { name: "People" }).waitFor();
    step("a reload in the same tab stays unlocked");

    await page.getByLabel("New Person username").fill("alice");
    await page.getByRole("button", { name: "Add Person" }).click();
    await manage("alice").waitFor();
    const people = await callApi("/admin/people", adminKey);
    assert.ok(people.body.people.some((person) => person.username === "alice"));
    step("the Host adds alice, and the API lists her");

    // Hold alice's key list back so the Host's newer selection answers first.
    await page.route("**/admin/people/*/keys", async (route) => {
      if (route.request().url().includes("/people/host/")) {
        await route.continue();
        return;
      }
      await setTimeout(400);
      await route.continue();
    });
    await manage("alice").click();
    await manage("host").click();
    await selected.getByRole("heading", { name: "host" }).waitFor();
    await setTimeout(700);
    assert.equal(
      await selected.getByRole("heading", { name: "alice" }).count(),
      0
    );
    await page.unroute("**/admin/people/*/keys");
    step("a slow key list for alice never replaces the newer host selection");

    await manage("alice").click();
    await selected.getByRole("heading", { name: "alice" }).waitFor();
    await selected.getByText("No keys yet.").waitFor();
    await page.getByLabel("Key label").fill("Alice phone");
    await page.getByRole("button", { name: "Mint key" }).click();
    const issued = selected.getByRole("status");
    await issued.getByText("Orbis will not show it again.").waitFor();
    const shown = await issued.locator("code").textContent();
    const token = shown.trim();
    assert.ok(token.length >= 32);
    await issued.getByRole("button", { name: "Copy key" }).click();
    await issued.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      token
    );
    await shot("issued-key");
    const me = await callApi("/me", token);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, "alice");
    step(
      "the Host mints 'Alice phone', copies it once, and it signs in as alice"
    );

    await issued.getByRole("button", { name: "Done" }).click();
    assert.equal(await page.getByText(token).count(), 0);
    await manage("host").click();
    await manage("alice").click();
    await selected.getByText("Last used").waitFor();
    assert.equal(await page.getByText(token).count(), 0);
    step("Done hides the key for good, and the list shows when it was used");

    await selected.getByRole("button", { name: "Revoke Alice phone" }).click();
    await selected.getByText("No keys yet.").waitFor();
    const revoked = await callApi("/me", token);
    assert.equal(revoked.status, 401);
    step("revoking 'Alice phone' makes the API refuse it");

    await selected.getByRole("button", { name: "Remove alice" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("You cannot undo it.").waitFor();
    // The dialog fades in; capture it once the fade ends.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await shot("remove-alice");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await manage("alice").waitFor();
    await selected.getByRole("button", { name: "Remove alice" }).click();
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().startsWith(`${apiUrl}/admin/people/`)
    );
    await dialog.getByRole("button", { exact: true, name: "Remove" }).click();
    const removedResponse = await removed;
    assert.equal(removedResponse.status(), 200);
    await dialog.waitFor({ state: "detached" });
    await manage("alice").waitFor({ state: "detached" });
    const remaining = await callApi("/admin/people", adminKey);
    assert.deepEqual(
      remaining.body.people.map((person) => person.username),
      ["host"]
    );
    await shot("people");
    step("Cancel keeps alice; confirming removes her from the Group");

    await page.getByRole("button", { name: "Lock" }).click();
    await page.getByRole("heading", { name: "Manage your Group" }).waitFor();
    assert.deepEqual(await storedAdminKey(page), {
      local: null,
      session: null,
    });
    step("Lock clears the admin key from the tab");

    await unlock(adminKey);
    await page.getByRole("heading", { name: "People" }).waitFor();
    const other = await context.newPage();
    await other.goto(`${webUrl}/admin`);
    await other.getByRole("heading", { name: "Manage your Group" }).waitFor();
    assert.deepEqual(await storedAdminKey(other), {
      local: null,
      session: null,
    });
    await other.close();
    step("a new tab does not get the admin key");

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
    `admin journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
