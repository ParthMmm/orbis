// The Host manages the Group from the admin page against a real Orbis API: the built
// web client in `vite preview` calls a throwaway server whose Group holds the Host
// and alice, each with one daily key. Fresh browsers join and sign in with what the
// page shows.
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
  submitForm,
  textOf,
  waitFor,
} from "./helpers.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const artifacts = path.join(root, ".cache/web-admin");
const devicePort = 4441;
const webPort = 3341;
const apiUrl = `http://127.0.0.1:${devicePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const hostKey = randomBytes(24).toString("base64url");
const aliceKey = randomBytes(24).toString("base64url");
const PASSCODE_FORM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/u;

// What the API itself says, outside the browser.
const callApi = async (pathname, key) => {
  const response = await fetch(`${apiUrl}${pathname}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { body: await response.json(), status: response.status };
};

const tryJoin = async (page, username, value) => {
  const form = page.getByRole("form", { name: "Join with the Group Passcode" });
  const answer = await submitForm(form, "/sign-in/join", {
    "Group Passcode": value,
    Username: username,
  });
  return { ...answer, form };
};

const dataDirectory = await mkdtemp(path.join(tmpdir(), "orbis-admin-"));
await writeFile(
  path.join(dataDirectory, "devices.json"),
  JSON.stringify({
    keys: [
      keyRecord("host-daily", "Host browser", "host", hostKey),
      keyRecord("alice-daily", "Alice phone", "alice", aliceKey),
      keyRecord(
        "vanta-node",
        "Vanta",
        "host",
        randomBytes(24).toString("base64url"),
        "node"
      ),
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

const steps = [];
const step = (name, detail = {}) => steps.push({ name, ...detail });
try {
  await Promise.all([waitFor(`${apiUrl}/health`), waitFor(webUrl)]);
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const violations = [];
    const openContext = async (options = {}) => {
      const context = await browser.newContext(options);
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
      return context;
    };
    // A browser with no key, at the sign-in page.
    const freshBrowser = async () => {
      const context = await openContext();
      const page = await context.newPage();
      await page.goto(webUrl);
      await page.getByRole("heading", { name: "Sign in to Orbis" }).waitFor();
      return { context, page };
    };

    const friend = await openContext();
    const friendPage = await friend.newPage();
    await signInWithKey(friendPage, webUrl, aliceKey);
    await friendPage.getByText("Signed in as alice").waitFor();
    const friendNav = friendPage.getByRole("navigation", { name: "Main" });
    await friendNav.getByRole("link", { name: "Devices" }).waitFor();
    assert.equal(
      await friendNav.getByRole("link", { name: "Admin" }).count(),
      0
    );
    await friendPage.screenshot({ path: path.join(artifacts, "friend.png") });
    await friendPage.goto(`${webUrl}/admin`);
    await friendPage.getByRole("heading", { name: "Library" }).waitFor();
    assert.equal(new URL(friendPage.url()).pathname, "/");
    assert.equal(
      await friendPage.getByRole("heading", { name: "Group Passcode" }).count(),
      0
    );
    await friend.close();
    step("a friend sees no Admin link, and /admin sends them to the Library");

    const host = await openContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await host.newPage();
    const shot = (name) =>
      page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    await signInWithKey(page, webUrl, hostKey);
    await page.getByText("Signed in as host").waitFor();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Admin" })
      .click();
    await page.getByRole("heading", { name: "Admin" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/admin");
    const passcodeSection = page.getByRole("region", {
      name: "Group Passcode",
    });
    await passcodeSection.getByText("Joining is closed.").waitFor();
    await shot("closed");
    step(
      "the Host sees the Admin link, and the page opens on their own key with joining closed"
    );

    await passcodeSection.getByRole("button", { name: "Open joining" }).click();
    const passcodeCode = passcodeSection.getByLabel("Group Passcode");
    await passcodeCode.waitFor();
    const passcode = await textOf(passcodeCode);
    assert.match(passcode, PASSCODE_FORM);
    const stored = await callApi("/admin/passcode", hostKey);
    assert.deepEqual(stored.body, { passcode });
    await passcodeSection
      .getByRole("button", { name: "Copy passcode" })
      .click();
    await passcodeSection.getByRole("button", { name: "Copied" }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, passcode);
    await shot("passcode");
    step(
      "Open joining makes a random 12-character passcode, and Copy puts it on the clipboard",
      { passcode }
    );

    const carol = await freshBrowser();
    const joined = await tryJoin(carol.page, "carol", copied);
    assert.equal(joined.status, 201);
    await carol.page.getByText("Signed in as carol").waitFor();
    await carol.context.close();
    const people = page.getByRole("list", { name: "People in the Group" });
    await page.reload();
    await people.getByRole("heading", { name: "carol" }).waitFor();
    step(
      "a new browser joins as carol with the copied passcode, and People lists her"
    );

    await passcodeSection.getByRole("button", { name: "New passcode" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "New passcode" })
      .click();
    await passcodeCode.filter({ hasNotText: passcode }).waitFor();
    const replaced = await textOf(passcodeCode);
    assert.match(replaced, PASSCODE_FORM);
    assert.notEqual(replaced, passcode);
    const erin = await freshBrowser();
    const stale = await tryJoin(erin.page, "erin", passcode);
    assert.equal(stale.status, 403);
    await erin.context.close();
    step(
      "New passcode, after a confirmation, replaces it and the old one fails"
    );

    await passcodeSection
      .getByRole("button", { name: "Close joining" })
      .click();
    await passcodeSection.getByText("Joining is closed.").waitFor();
    const dave = await freshBrowser();
    const refused = await tryJoin(dave.page, "dave", replaced);
    assert.equal(refused.status, 403);
    assert.equal(
      await textOf(refused.form.getByRole("alert")),
      refused.body.message
    );
    await dave.context.close();
    step(
      "Close joining makes the current passcode fail with the API's message",
      {
        message: refused.body.message,
      }
    );

    const reloads = [];
    const watchReload = (request) => {
      if (new URL(request.url()).pathname === "/admin/people") {
        reloads.push(request.url());
      }
    };
    page.on("request", watchReload);
    await page
      .getByRole("button", { name: "Show Sign-in Code for alice" })
      .click();
    const aliceCode = page.getByRole("status", {
      name: "Sign-in Code for alice",
    });
    await aliceCode.waitFor();
    page.off("request", watchReload);
    assert.deepEqual(reloads, []);
    const code = await textOf(aliceCode);
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    await shot("people");
    const recovered = await freshBrowser();
    const codeForm = recovered.page.getByRole("form", {
      name: "Sign in with a login code",
    });
    await codeForm.getByLabel("Sign-in Code").fill(code);
    await codeForm.getByRole("button", { name: "Sign in" }).click();
    await recovered.page.getByText("Signed in as alice").waitFor();
    await recovered.context.close();
    step(
      "the Host shows a Sign-in Code for alice without reloading the page, and it signs a new browser in as alice",
      {
        code,
      }
    );

    const keys = page.getByRole("list", { name: "Keys" });
    await page.reload();
    await keys.getByText("Alice phone").waitFor();
    const nodeRow = keys.getByRole("listitem").filter({ hasText: "Vanta" });
    await nodeRow.getByText("Audio node").waitFor();
    assert.equal(await nodeRow.getByRole("button").count(), 0);
    await page
      .getByLabel("Person", { exact: true })
      .selectOption({ label: "alice" });
    await page.getByLabel("Key label").fill("Raycast");
    await page.getByRole("button", { name: "Create key" }).click();
    const issued = page.getByRole("status").filter({
      hasText: "Orbis will not show it again.",
    });
    const token = await textOf(issued.locator("code"));
    assert.ok(token.length >= 32);
    await issued.getByRole("button", { name: "Copy key" }).click();
    await issued.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      token
    );
    const me = await callApi("/me", token);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, "alice");
    await keys.getByText("Raycast").waitFor();
    await shot("keys");
    await issued.getByRole("button", { name: "Done" }).click();
    assert.equal(await page.getByText(token).count(), 0);
    step(
      "Vanta's key shows as Audio node with no Revoke; the Host creates a Raycast key for alice, copies it once, and it signs in as alice"
    );

    const revokeDialog = page.getByRole("alertdialog");
    await keys
      .getByRole("button", { name: "Revoke Raycast for alice" })
      .click();
    await revokeDialog.getByText("signed out as alice").waitFor();
    await revokeDialog
      .getByRole("button", { exact: true, name: "Revoke" })
      .click();
    // The open dialog hides the Keys list from role queries, so wait for it to
    // close (it closes only after the API answers) before looking at the list.
    await revokeDialog.waitFor({ state: "detached" });
    await keys.getByText("Raycast").waitFor({ state: "detached" });
    const afterRevoke = await callApi("/me", token);
    assert.equal(afterRevoke.status, 401);
    step("revoking the Raycast key after confirming makes the API refuse it");

    assert.equal(
      await page.getByRole("button", { name: "Remove host" }).count(),
      0
    );
    await page.getByRole("button", { name: "Remove carol" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("You cannot undo it.").waitFor();
    // The dialog fades in; capture it once the fade ends.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await shot("remove-carol");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    await people.getByRole("heading", { name: "carol" }).waitFor();
    await page.getByRole("button", { name: "Remove carol" }).click();
    await dialog.getByRole("button", { exact: true, name: "Remove" }).click();
    await dialog.waitFor({ state: "detached" });
    await people
      .getByRole("heading", { name: "carol" })
      .waitFor({ state: "detached" });
    const remaining = await callApi("/admin/people", hostKey);
    assert.deepEqual(
      remaining.body.people.map((person) => person.username).toSorted(),
      ["alice", "host"]
    );
    step(
      "the Host cannot remove themselves; Cancel keeps carol, and confirming removes her"
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
    `admin journey passed: ${steps.length} steps, artifacts in ${artifacts}`
  );
} finally {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await rm(dataDirectory, { force: true, recursive: true });
}
