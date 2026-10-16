// Join with the Group Passcode and sign in with a code against a real Orbis API:
// the built web client in `vite preview` calls a throwaway server whose Group
// holds the Host with one daily key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

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
const artifacts = path.join(root, ".cache/web-sign-in");
const devicePort = 4421;
const webPort = 3321;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const hostKey = randomBytes(24).toString("base64url");
let passcode = "";

// The Group makes the passcode; the journey reads it like a Host would.
const openJoining = async () => {
  const response = await fetch(`${apiUrl}/admin/passcode`, {
    headers: { authorization: `Bearer ${hostKey}` },
    method: "POST",
  });
  ({ passcode } = await response.json());
  return response.status;
};

// A wrong guess from outside the browser, from the same address as the page.
const guessCode = () =>
  fetch(`${apiUrl}/sign-in/code`, {
    body: JSON.stringify({ code: "ZZZZZZZZ", label: "Guessing" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-sign-in-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [keyRecord("journey-key", "Sign-in journey", "host", hostKey)],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const startApi = () =>
  spawn("bun", ["apps/web/e2e/api-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: dataDirectory,
      ORBIS_FIXTURE_ORIGIN: webUrl,
      ORBIS_FIXTURE_PORT: String(devicePort),
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
    const shot = (name) =>
      page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    const codeForm = page.getByRole("form", { name: "Sign in with a code" });
    const joinForm = page.getByRole("form", { name: "Join Orbis" });
    const join = (username, value) =>
      submitForm(joinForm, "/sign-in/join", {
        "Group Passcode": value,
        Username: username,
      });
    const redeem = (code) =>
      submitForm(codeForm, "/sign-in/code", { "Sign-in Code": code });
    const expectRefusal = async (form, answer, status) => {
      assert.equal(answer.status, status);
      assert.notEqual(answer.body.message ?? "", "");
      assert.equal(await textOf(form.getByRole("alert")), answer.body.message);
      assert.equal(await storedKey(page), null);
    };

    await page.goto(webUrl);
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/sign-in");
    await codeForm.getByLabel("Sign-in Code").waitFor();
    await joinForm.getByLabel("Group Passcode").waitFor();
    await shot("signed-out");
    step("a signed-out visit to / shows a code form and a join form");

    const closed = await join("bob", "anything");
    await expectRefusal(joinForm, closed, 403);
    await shot("join-closed");
    step("joining while the Host has no passcode shows the API's refusal", {
      message: closed.body.message,
    });

    assert.equal(await openJoining(), 200);
    const wrong = await join("bob", "wrong passcode");
    await expectRefusal(joinForm, wrong, 403);
    step("a wrong passcode shows the API's refusal and stores nothing", {
      message: wrong.body.message,
    });

    const taken = await join("host", passcode);
    await expectRefusal(joinForm, taken, 409);
    step("a taken username shows the API's refusal", {
      message: taken.body.message,
    });

    // A pasted passcode with spaces and lower case still joins.
    const joined = await join(
      "bob",
      `  ${passcode.slice(0, 6).toLowerCase()} ${passcode.slice(6)}  `
    );
    assert.equal(joined.status, 201);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await page.getByText("Signed in as bob").waitFor();
    assert.equal(await storedKey(page), joined.body.key);
    assert.match(joined.payload.label, /^Chrome on /u);
    await page.reload();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    await shot("joined");
    step(
      "the right passcode creates bob, stores the returned key, and survives a reload",
      { label: joined.payload.label }
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    assert.equal(await storedKey(page), null);
    step("sign out clears the key");

    let sentCode = false;
    const watchCode = (request) => {
      sentCode ||= new URL(request.url()).pathname === "/sign-in/code";
    };
    page.on("request", watchCode);
    await codeForm.getByLabel("Sign-in Code").fill("abc");
    await codeForm.getByRole("button").click();
    await codeForm
      .getByRole("alert")
      .getByText("Enter the eight-character code")
      .waitFor();
    page.off("request", watchCode);
    assert.equal(sentCode, false);
    step("a code that is too short is refused without calling the API");

    const unknown = await redeem("zzzz-zzzz");
    assert.equal(unknown.payload.code, "ZZZZZZZZ");
    await expectRefusal(codeForm, unknown, 404);
    await shot("unknown-code");
    step(
      "an unknown code is sent without its dash, in capitals, and the API's refusal shows",
      { message: unknown.body.message }
    );

    await page.evaluate(() => localStorage.setItem("orbis.apiKey", "revoked"));
    await page.goto(webUrl);
    await page
      .getByRole("alert")
      .getByText("Your saved key no longer works.")
      .waitFor();
    assert.equal(await storedKey(page), null);
    step("a saved key the API rejects is dropped with a notice");

    await signInWithKey(page, webUrl, hostKey);
    await page.getByRole("heading", { name: "Library" }).waitFor();
    api.kill("SIGTERM");
    await setTimeout(500);
    await page.reload();
    await page
      .getByRole("alert")
      .getByText("Orbis could not be reached.")
      .waitFor();
    assert.equal(await storedKey(page), hostKey);
    await shot("unreachable");
    step("an unreachable API keeps the key and says why");

    api = startApi();
    await waitFor(`${apiUrl}/health`);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("heading", { name: "Library" }).waitFor();
    step("Try again signs back in once the API is back");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await guessCode();
    }
    const limited = await redeem("zzzzzzzz");
    await expectRefusal(codeForm, limited, 429);
    step("after many wrong guesses the API's rate-limit message shows", {
      message: limited.body.message,
    });

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
