// List and revoke devices against a real Orbis API: the built web client in `vite
// preview` calls a throwaway server whose trust store holds two of the Host's daily
// keys, the Host's admin key, and a key for a second Person.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-next-devices");
const apiPort = 4460;
const devicePort = 4461;
const webPort = 3361;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const tokens = {
  admin: randomBytes(24).toString("base64url"),
  alice: randomBytes(24).toString("base64url"),
  laptop: randomBytes(24).toString("base64url"),
  phone: randomBytes(24).toString("base64url"),
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

const keyRecord = (id, label, personId, scope, token) => ({
  addedAt: new Date().toISOString(),
  id,
  label,
  lastUsedAt: null,
  personId,
  scope,
  tokenHash: createHash("sha256").update(token).digest("hex"),
});

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-devices-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      keyRecord("laptop-key", "Laptop", "host", "daily", tokens.laptop),
      keyRecord("phone-key", "Phone", "host", "daily", tokens.phone),
      keyRecord("admin-key", "Recovery", "host", "admin", tokens.admin),
      keyRecord("alice-key", "Alice phone", "alice", "daily", tokens.alice),
    ],
    people: [
      { id: "host", removed: false, username: "host" },
      { id: "alice", removed: false, username: "alice" },
    ],
    version: 2,
  })
);
// Development mode lets the device listener accept the preview's loopback Origin.
const api = spawn("bun", ["apps/server/src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "development",
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

// A direct call with no Origin, the way a native client would make it.
const meStatus = async (token) => {
  const response = await fetch(`${apiUrl}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
};

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
    const storedKey = () =>
      page.evaluate(() => localStorage.getItem("orbis.apiKey"));
    const deviceList = page.getByRole("list", { name: "Your devices" });
    const deviceNames = () => deviceList.getByRole("heading").allTextContents();

    await page.goto(webUrl);
    await page.getByLabel("API key").fill(tokens.laptop);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("the Laptop key signs in");

    await page.getByRole("link", { name: "Devices" }).click();
    await page.getByRole("heading", { name: "Devices" }).waitFor();
    await deviceList.getByRole("heading", { name: "Phone" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/devices");
    const listed = await deviceNames();
    assert.deepEqual(listed.toSorted(), ["Laptop", "Phone"]);
    const laptopRow = deviceList
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "Laptop" }) });
    await laptopRow.getByText("This device").waitFor();
    assert.equal(await deviceList.getByText("This device").count(), 1);
    await page.screenshot({ path: path.join(artifacts, "devices.png") });
    step(
      "Devices lists Laptop (This device) and Phone, not the admin key or alice's key"
    );

    await page.getByRole("button", { name: "Revoke Phone" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("heading", { name: "Revoke Phone?" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-phone.png") });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await dialog.waitFor({ state: "detached" });
    await deviceList
      .getByRole("heading", { name: "Phone" })
      .waitFor({ state: "detached" });
    assert.deepEqual(await deviceNames(), ["Laptop"]);
    assert.equal(await meStatus(tokens.phone), 401);
    assert.equal(await meStatus(tokens.alice), 200);
    assert.equal(await meStatus(tokens.admin), 200);
    await page.screenshot({ path: path.join(artifacts, "phone-revoked.png") });
    step(
      "revoking Phone after confirming removes it, and the API refuses the Phone key"
    );

    await page.getByRole("button", { name: "Revoke Laptop" }).click();
    await dialog.getByRole("heading", { name: "Revoke Laptop?" }).waitFor();
    await dialog.getByText("This is the device you are using.").waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-laptop.png") });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");
    assert.equal(await storedKey(), null);
    assert.equal(await meStatus(tokens.laptop), 401);
    await page.screenshot({ path: path.join(artifacts, "signed-out.png") });
    step(
      "revoking this device signs out, clears the key, and the API refuses the Laptop key"
    );

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
    `devices journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
