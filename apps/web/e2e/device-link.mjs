// Sign in a second browser with a Device Link against a real Orbis API: browser A is
// signed in with a daily key, browser B shows a code, A approves it, and B signs in
// as the same Person with its own key (ADR 0016).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-device-link");
const apiPort = 4450;
const devicePort = 4451;
const webPort = 3351;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const keyA = randomBytes(24).toString("base64url");
const deviceLabel = "Journey browser B";

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

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-device-link-"));
const devicesPath = path.join(dataDirectory, "devices.json");
await writeFile(
  devicesPath,
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "journey-key-a",
        label: "Browser A",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: createHash("sha256").update(keyA).digest("hex"),
      },
    ],
    people: [{ id: "host", removed: false, username: "host" }],
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
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, ORBIS_API_URL: apiUrl },
    stdio: "ignore",
  }
);

const callApi = async (route, { key, payload }) => {
  const headers = { "content-type": "application/json" };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  const response = await fetch(`${apiUrl}${route}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method: payload === undefined ? "GET" : "POST",
  });
  return { body: await response.json(), status: response.status };
};

const storedKey = (page) =>
  page.evaluate(() => localStorage.getItem("orbis.apiKey"));

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
    const openContext = async (name) => {
      const context = await browser.newContext();
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
    const pageA = await openContext("A");
    const pageB = await openContext("B");

    await pageA.goto(`${webUrl}/sign-in`);
    await pageA.getByLabel("API key").fill(keyA);
    await pageA.getByRole("button", { exact: true, name: "Sign in" }).click();
    await pageA.getByText("Signed in as host").waitFor();
    step("browser A signs in with its daily key");

    await pageB.goto(`${webUrl}/sign-in`);
    await pageB.getByRole("button", { name: "Sign in with a code" }).click();
    await pageB.getByLabel("Device name").fill(deviceLabel);
    await pageB.getByRole("button", { name: "Get a code" }).click();
    const codeOutput = pageB.getByLabel("Your code");
    await codeOutput.waitFor();
    const shown = await codeOutput.textContent();
    const code = shown.trim();
    assert.match(
      code,
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u
    );
    const qrTitle = await pageB.locator("svg title").textContent();
    assert.equal(qrTitle, `${webUrl}/link#${code}`);
    await pageB.getByText("Waiting for approval").waitFor();
    assert.equal(await storedKey(pageB), null);
    await pageB.screenshot({ path: path.join(artifacts, "b-code.png") });
    step("browser B, signed out, shows a code and a QR code for /link", {
      code,
    });

    await pageA.goto(`${webUrl}/link#${code}`);
    await pageA.getByRole("heading", { name: "Add a device" }).waitFor();
    assert.equal(await pageA.getByLabel("Code").inputValue(), code);
    step("the QR link opens Add a device with the code filled in");

    await pageA.getByRole("button", { name: "Continue" }).click();
    await pageA.getByText("Approve only a device in front of you").waitFor();
    await pageA.getByText(`Device name: ${deviceLabel}`).waitFor();
    await pageA.screenshot({ path: path.join(artifacts, "a-confirm.png") });
    step("browser A sees the device name and the warning before approving");

    await pageA.getByRole("button", { name: `Approve ${deviceLabel}` }).click();
    await pageA.getByText(`Approved ${deviceLabel}.`).waitFor();
    await pageA.screenshot({ path: path.join(artifacts, "a-approved.png") });
    step("browser A approves the code");

    await pageB.getByRole("heading", { name: "Library" }).waitFor();
    await pageB.getByText("Signed in as host").waitFor();
    const keyB = await storedKey(pageB);
    assert.ok(keyB);
    assert.notEqual(keyB, keyA);
    assert.equal(new URL(pageB.url()).pathname, "/");
    await pageB.screenshot({ path: path.join(artifacts, "b-signed-in.png") });
    step("browser B signs in as the same Person with its own key");

    const me = await callApi("/me", { key: keyB });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, "host");
    const store = JSON.parse(await readFile(devicesPath, "utf-8"));
    const minted = store.keys.find(
      (record) =>
        record.tokenHash === createHash("sha256").update(keyB).digest("hex")
    );
    assert.equal(minted?.label, deviceLabel);
    assert.equal(minted?.scope, "daily");
    assert.equal(minted?.personId, "host");
    assert.ok(!JSON.stringify(store).includes(keyB));
    step(
      "browser B's key works on the API and is a daily key in the trust store"
    );

    const again = await callApi("/device-links/approve", {
      key: keyA,
      payload: { userCode: code },
    });
    assert.equal(again.status, 404);
    await pageA.getByRole("button", { name: "Add another device" }).click();
    await pageA.getByLabel("Code").fill(code);
    await pageA.getByRole("button", { name: "Continue" }).click();
    await pageA
      .getByRole("alert")
      .getByText("No device is waiting with that code.")
      .waitFor();
    step("a second approval of the same code fails");

    await pageA.getByLabel("Code").fill("ZZZZ-ZZZZ");
    await pageA.getByRole("button", { name: "Continue" }).click();
    await pageA
      .getByRole("alert")
      .getByText("No device is waiting with that code.")
      .waitFor();
    await pageA.screenshot({ path: path.join(artifacts, "a-invalid.png") });
    step("an unknown code is refused");

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
    `device-link journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
