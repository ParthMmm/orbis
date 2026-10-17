// List, add, and revoke devices against a real Orbis API: the built web client in
// `vite preview` calls a throwaway server whose trust store holds two of the Host's
// daily keys, a key stored as admin, and a key for a second Person. A second browser
// signs in with a Sign-in Code from the Devices page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  keyRecord,
  signInWithKey,
  storedKey,
  submitForm,
  textOf,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-devices");
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

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-devices-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      keyRecord("laptop-key", "Laptop", "host", tokens.laptop),
      keyRecord("phone-key", "Phone", "host", tokens.phone),
      keyRecord("admin-key", "Recovery", "host", tokens.admin, "admin"),
      keyRecord("alice-key", "Alice phone", "alice", tokens.alice),
    ],
    people: [
      { id: "host", removed: false, username: "host" },
      { id: "alice", removed: false, username: "alice" },
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
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
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
    const deviceList = page.getByRole("list", { name: "Your devices" });
    const deviceNames = () => deviceList.getByRole("heading").allTextContents();

    await signInWithKey(page, webUrl, tokens.laptop);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("the Laptop key signs in");

    await page.getByRole("link", { name: "Devices" }).click();
    await page.getByRole("heading", { name: "Devices" }).waitFor();
    await deviceList.getByRole("heading", { name: "Phone" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/devices");
    const listed = await deviceNames();
    assert.deepEqual(listed.toSorted(), ["Laptop", "Phone", "Recovery"]);
    const laptopRow = deviceList
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "Laptop" }) });
    await laptopRow.getByText("This device").waitFor();
    assert.equal(await deviceList.getByText("This device").count(), 1);
    await page.screenshot({ path: path.join(artifacts, "devices.png") });
    step(
      "Devices lists Laptop (This device), Phone, and Recovery, a key stored as admin, not alice's key"
    );

    await page.getByRole("button", { name: "Revoke Phone" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("heading", { name: "Revoke Phone?" }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-phone.png") });
    await page.route("**/me/devices/*", (route) =>
      route.fulfill({ body: "{}", status: 500 })
    );
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await dialog.getByRole("alert").getByText("Try again.").waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: "Revoke" }).isEnabled(),
      true
    );
    await page.screenshot({ path: path.join(artifacts, "revoke-failed.png") });
    await page.unroute("**/me/devices/*");
    step("a failed revoke keeps the dialog open and shows why inside it");

    await dialog.getByRole("button", { name: "Revoke" }).click();
    await dialog.waitFor({ state: "detached" });
    await deviceList
      .getByRole("heading", { name: "Phone" })
      .waitFor({ state: "detached" });
    const afterPhone = await deviceNames();
    assert.deepEqual(afterPhone.toSorted(), ["Laptop", "Recovery"]);
    assert.equal(await meStatus(tokens.phone), 401);
    assert.equal(await meStatus(tokens.alice), 200);
    assert.equal(await meStatus(tokens.admin), 200);
    await page.screenshot({ path: path.join(artifacts, "phone-revoked.png") });
    step(
      "revoking Phone after confirming removes it, and the API refuses the Phone key"
    );

    const shownCode = page.getByRole("status", { name: "Your Sign-in Code" });
    await page.getByRole("button", { name: "Sign in another device" }).click();
    await shownCode.waitFor();
    const firstCode = await textOf(shownCode);
    assert.match(firstCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    await page.getByText("Works once, until").waitFor();
    await page.getByRole("button", { name: "Get a new code" }).click();
    await page.waitForFunction(
      (previous) =>
        document
          .querySelector('[aria-label="Your Sign-in Code"]')
          ?.textContent.trim() !== previous,
      firstCode
    );
    const code = await textOf(shownCode);
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    await page.screenshot({ path: path.join(artifacts, "sign-in-code.png") });
    step(
      "Sign in another device shows a code as ABCD-EFGH, and Get a new code replaces it",
      {
        code,
      }
    );

    const newDevice = await browser.newContext();
    const other = await newDevice.newPage();
    await other.goto(webUrl);
    const codeForm = other.getByRole("form", {
      name: "Sign in with a login code",
    });
    await codeForm
      .getByLabel("Sign-in Code")
      .fill(code.toLowerCase().replace("-", " "));
    await codeForm.getByRole("button", { name: "Sign in" }).click();
    await other.getByRole("heading", { name: "Library" }).waitFor();
    await other.getByText("Signed in as host").waitFor();
    assert.notEqual(await storedKey(other), null);
    await other.screenshot({ path: path.join(artifacts, "redeemed.png") });
    await page.reload();
    await deviceList.getByRole("heading", { name: /^Chrome on /u }).waitFor();
    const namesAfterRedeem = await deviceNames();
    assert.equal(namesAfterRedeem.length, 3);
    step(
      "another browser types the code in lower case with a space, signs in as host, and appears on Devices under its browser name"
    );

    const thirdDevice = await browser.newContext();
    const third = await thirdDevice.newPage();
    await third.goto(webUrl);
    const thirdForm = third.getByRole("form", {
      name: "Sign in with a login code",
    });
    const reused = await submitForm(thirdForm, "/sign-in/code", {
      "Sign-in Code": code,
    });
    assert.equal(reused.status, 404);
    assert.equal(
      await textOf(thirdForm.getByRole("alert")),
      reused.body.message
    );
    const replaced = await submitForm(thirdForm, "/sign-in/code", {
      "Sign-in Code": firstCode,
    });
    assert.equal(replaced.status, 404);
    await thirdDevice.close();
    await newDevice.close();
    step(
      "the used code and the code it replaced do not work, and the page shows why",
      { message: reused.body.message }
    );

    await page.getByRole("button", { name: "Revoke Laptop" }).click();
    await dialog.getByRole("heading", { name: "Revoke Laptop?" }).waitFor();
    await dialog.getByText("This is the device you are using.").waitFor();
    await page.screenshot({ path: path.join(artifacts, "confirm-laptop.png") });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");
    assert.equal(await storedKey(page), null);
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
