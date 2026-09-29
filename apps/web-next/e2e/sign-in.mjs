// Sign in with a key against a real Orbis API: the built web client in `vite preview`
// calls a throwaway server with its own data directory and one enrolled key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-next-sign-in");
const apiPort = 4420;
const devicePort = 4421;
const webPort = 3321;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const key = randomBytes(24).toString("base64url");

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

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-sign-in-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "journey-key",
        label: "Sign-in journey",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(key).digest("hex"),
      },
    ],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
// Development mode lets the device listener accept the preview's loopback Origin.
const startApi = () =>
  spawn("bun", ["apps/server/src/index.ts"], {
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
let api = startApi();
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
    const storedKey = () =>
      page.evaluate(() => localStorage.getItem("orbis.apiKey"));
    const signIn = async (value) => {
      await page.getByLabel("API key").fill(value);
      await page.getByRole("button", { name: "Sign in" }).click();
    };

    await page.goto(webUrl);
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "signed-out.png") });
    step("signed out shows the form");

    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").getByText("Paste the API key").waitFor();
    step("an empty key asks for one");

    await signIn("not-a-real-key");
    await page
      .getByRole("alert")
      .getByText("That API key does not work.")
      .waitFor();
    assert.equal(await storedKey(), null);
    await page.screenshot({ path: path.join(artifacts, "wrong-key.png") });
    step("a wrong key is refused and not stored");

    await signIn(key);
    await page.getByRole("heading", { name: "Signed in as host" }).waitFor();
    assert.equal(await storedKey(), key);
    await page.screenshot({ path: path.join(artifacts, "signed-in.png") });
    step("the enrolled key signs in as host and is stored");

    await page.reload();
    await page.getByRole("heading", { name: "Signed in as host" }).waitFor();
    step("a reload stays signed in");

    await page.evaluate(() => localStorage.setItem("orbis.apiKey", "revoked"));
    await page.reload();
    await page
      .getByRole("alert")
      .getByText("Your saved key no longer works.")
      .waitFor();
    assert.equal(await storedKey(), null);
    step("a saved key the API rejects is dropped with a notice");

    await signIn(key);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(await storedKey(), null);
    step("sign out clears the key");

    await signIn(key);
    await page.getByRole("heading", { name: "Signed in as host" }).waitFor();
    api.kill("SIGTERM");
    await setTimeout(500);
    await page.reload();
    await page
      .getByRole("alert")
      .getByText("Orbis could not be reached.")
      .waitFor();
    assert.equal(await storedKey(), key);
    await page.screenshot({ path: path.join(artifacts, "unreachable.png") });
    step("an unreachable API keeps the key and says why");

    api = startApi();
    await waitFor(`http://127.0.0.1:${apiPort}/health`);
    await page.reload();
    await page.getByRole("heading", { name: "Signed in as host" }).waitFor();
    step("the same key works once the API is back");

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
    `sign-in journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
