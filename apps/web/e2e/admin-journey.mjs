import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../../..");
const port = 5179;
const server = spawn(
  "bun",
  ["x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port)],
  { cwd: path.join(root, "apps/web"), stdio: "ignore" }
);
const people = [{ id: "host", username: "host" }];
const keys = [];
const calls = [];
const results = [];
let delayAliceKeys = true;

const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`http://127.0.0.1:${port}`);
      if (response.ok) {
        return;
      }
    } catch {
      // The preview may not be listening yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error("Web preview did not start");
};

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    // eslint-disable-next-line complexity -- One route fixture covers the full admin journey.
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authorization = request.headers().authorization ?? "";
      const payload = request.postDataJSON();
      let credential = "none";
      if (authorization === "Bearer admin-key") {
        credential = "admin";
      } else if (authorization === "Bearer daily-key") {
        credential = "daily";
      }
      calls.push({
        credential,
        method: request.method(),
        path: url.pathname,
      });
      const respond = (status, body) =>
        route.fulfill({
          body: JSON.stringify(body),
          contentType: "application/json",
          status,
        });
      if (url.pathname.endsWith("/me")) {
        return respond(200, {
          autoDownload: true,
          id: "host",
          username: "host",
        });
      }
      if (url.pathname.endsWith("/sets")) {
        return respond(200, { sets: [] });
      }
      if (url.pathname.endsWith("/tags")) {
        return respond(200, { tags: [] });
      }
      if (authorization !== "Bearer admin-key") {
        return respond(403, { message: "An admin key is required." });
      }
      if (
        url.pathname.endsWith("/admin/people") &&
        request.method() === "GET"
      ) {
        return respond(200, { people });
      }
      if (
        url.pathname.endsWith("/admin/people") &&
        request.method() === "POST"
      ) {
        const person = { id: "alice", username: payload.username };
        people.push(person);
        return respond(201, person);
      }
      if (
        url.pathname.endsWith("/admin/people/alice") &&
        request.method() === "DELETE"
      ) {
        people.splice(
          people.findIndex((person) => person.id === "alice"),
          1
        );
        return respond(200, { id: "alice", username: "alice" });
      }
      if (
        url.pathname.endsWith("/admin/people/alice/keys") &&
        request.method() === "GET"
      ) {
        if (delayAliceKeys) {
          delayAliceKeys = false;
          await setTimeout(350);
        }
        return respond(200, { keys });
      }
      if (
        url.pathname.endsWith("/admin/people/host/keys") &&
        request.method() === "GET"
      ) {
        return respond(200, { keys: [] });
      }
      if (
        url.pathname.endsWith("/admin/people/alice/keys") &&
        request.method() === "POST"
      ) {
        const key = {
          addedAt: "2026-09-29T00:00:00.000Z",
          id: "alice-key",
          label: payload.label,
          lastUsedAt: "2026-09-29T01:00:00.000Z",
          personId: "alice",
          scope: "daily",
        };
        keys.push(key);
        return respond(201, { ...key, token: "one-time-alice-token" });
      }
      if (
        url.pathname.endsWith("/admin/keys/alice-key") &&
        request.method() === "DELETE"
      ) {
        keys.splice(0);
        return respond(200, {
          addedAt: "2026-09-29T00:00:00.000Z",
          id: "alice-key",
          label: "Alice phone",
          lastUsedAt: "2026-09-29T01:00:00.000Z",
          personId: "alice",
          scope: "daily",
        });
      }
      return respond(404, { message: "Not found" });
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel("API key").fill("daily-key");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Manage people" }).click();
    await page.getByLabel("Admin key").fill("daily-key");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByText("An admin key is required.").waitFor();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("orbis.adminKey")),
      null
    );
    results.push("daily key cannot enter admin page");

    await page.getByLabel("Admin key").fill("admin-key");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("heading", { name: "People" }).waitFor();
    await page.getByLabel("New Person username").fill("alice");
    await page.getByRole("button", { name: "Add Person" }).click();
    await page.getByRole("button", { name: "Manage alice" }).click();
    await page.getByRole("button", { name: "Manage host" }).click();
    await setTimeout(500);
    assert.equal(await page.getByRole("heading", { name: "host" }).count(), 1);
    results.push("older key response cannot replace selected Person");
    await page.getByRole("button", { name: "Manage alice" }).click();
    await page.getByLabel("Key label").fill("Alice phone");
    await page.getByRole("button", { name: "Mint key" }).click();
    await page.getByText("one-time-alice-token").waitFor();
    await page.getByRole("button", { name: "Copy key" }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "one-time-alice-token"
    );
    await mkdir(path.join(root, ".cache/admin-journey"), { recursive: true });
    await page.screenshot({
      path: path.join(root, ".cache/admin-journey/issued-key.png"),
    });
    await page.getByRole("button", { name: "Done" }).click();
    assert.equal(await page.getByText("one-time-alice-token").count(), 0);
    await page.getByText("Last used").waitFor();
    await page.getByRole("button", { name: "Revoke Alice phone" }).click();
    assert.equal(keys.length, 0);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Remove alice" }).click();
    assert.equal(people.length, 2);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove alice" }).click();
    await page
      .getByRole("button", { name: "Manage alice" })
      .waitFor({ state: "detached" });
    results.push(
      "Host adds and removes Person, copies one-time key, sees use time, revokes"
    );

    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("orbis.adminKey")),
      "admin-key"
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("orbis.adminKey")),
      null
    );
    await mkdir(path.join(root, ".cache/admin-journey"), { recursive: true });
    await page.screenshot({
      path: path.join(root, ".cache/admin-journey/people.png"),
    });
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`http://127.0.0.1:${port}`);
    await reopened.getByRole("button", { name: "Manage people" }).click();
    await reopened.getByLabel("Admin key").waitFor();
    assert.equal(
      await reopened.evaluate(() => sessionStorage.getItem("orbis.adminKey")),
      null
    );
    results.push("closing tab forgets admin key");
    assert.ok(calls.every((call) => !call.path.includes("admin-key")));
    await writeFile(
      path.join(root, ".cache/admin-journey/result.json"),
      JSON.stringify({ calls, results }, null, 2)
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
