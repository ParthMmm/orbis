import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const requireDesktop = createRequire(
  path.resolve(root, "apps/desktop/package.json")
);
const directory = await mkdtemp(path.join(tmpdir(), "orbis-smoke-"));
const server = spawn("bun", ["apps/server/src/index.ts"], {
  cwd: root,
  env: { ...process.env, ORBIS_DATA_DIR: directory, ORBIS_PORT: "0" },
  stdio: "pipe",
});
const serverExit = once(server, "exit");
let logs = "";
server.stderr.on("data", (chunk) => {
  logs += chunk;
});
server.stdout.on("data", (chunk) => {
  logs += chunk;
});
let app;
try {
  const waitForPort = async (attempts) => {
    if (server.exitCode !== null) {
      throw new Error(logs);
    }
    const port = /Orbis API: http:\/\/127\.0\.0\.1:(?<port>\d+)/u.exec(logs)
      ?.groups?.port;
    if (port || attempts === 0) {
      return port;
    }
    await delay(100);
    return waitForPort(attempts - 1);
  };
  const port = await waitForPort(100);
  assert.ok(port, `Server did not start: ${logs}`);
  app = await electron.launch({
    args: [".vite/build/main.js"],
    cwd: path.resolve(root, "apps/desktop"),
    env: { ...process.env, ORBIS_PORT: port },
    executablePath: requireDesktop("electron"),
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Renderer:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(message.text());
    }
  });
  await page.reload();
  await page.getByRole("heading", { name: "Start your collection" }).waitFor();
  const form = page.getByRole("region", { name: "Save a set" });
  await form
    .getByLabel("YouTube or SoundCloud URL")
    .fill("https://youtu.be/abcdefghijk?t=30");
  await form.getByLabel("Title", { exact: true }).fill("Night session");
  await form.getByLabel("Tags", { exact: true }).fill("Techno");
  await form.getByRole("button", { exact: true, name: "Add tag" }).click();
  await form.getByRole("button", { exact: true, name: "Save set" }).click();
  await page.getByRole("link", { name: "Night session" }).waitFor();
  await page.getByLabel("Search", { exact: true }).fill("missing");
  await page.getByRole("heading", { name: "No matching sets" }).waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("checkbox", { exact: true, name: "techno" }).check();
  await page.getByLabel("Source", { exact: true }).selectOption("soundcloud");
  await page.getByRole("heading", { name: "No matching sets" }).waitFor();
  await page.getByLabel("Source", { exact: true }).selectOption("youtube");
  await page.getByRole("link", { name: "Night session" }).waitFor();
  await page
    .getByRole("button", { name: "Edit tags for Night session" })
    .click();
  const editor = page.getByRole("form", {
    name: "Edit tags for Night session",
  });
  await editor.getByRole("button", { name: "Remove tag techno" }).click();
  await editor.getByLabel("Tags", { exact: true }).fill("ambient");
  await editor.getByRole("button", { exact: true, name: "Add tag" }).click();
  await editor.getByRole("button", { name: "Save tags" }).click();
  await page.getByRole("heading", { name: "No matching sets" }).waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("checkbox", { exact: true, name: "ambient" }).waitFor();
  await page.reload();
  await page.getByRole("link", { name: "Night session" }).waitFor();
  await page
    .getByRole("button", { name: "Edit title for Night session" })
    .click();
  const titleEditor = page.getByRole("form", {
    name: "Edit title for Night session",
  });
  await titleEditor.getByLabel("Title", { exact: true }).fill("Night renamed");
  await titleEditor.getByRole("button", { name: "Save title" }).click();
  await page.getByRole("link", { name: "Night renamed" }).waitFor();
  await page.getByLabel("New playlist", { exact: true }).fill("Evenings");
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await page.getByRole("heading", { name: "This playlist is empty" }).waitFor();
  await page
    .getByLabel("Add a saved set", { exact: true })
    .selectOption({ label: "Night renamed" });
  await page
    .getByRole("button", { exact: true, name: "Add to playlist" })
    .click();
  await page.getByRole("link", { name: "Night renamed" }).waitFor();
  await page
    .getByRole("button", {
      exact: true,
      name: "Remove Night renamed from playlist",
    })
    .click();
  await page.getByRole("heading", { name: "This playlist is empty" }).waitFor();
  await page.getByLabel("View", { exact: true }).selectOption("");
  await page.getByRole("link", { name: "Night renamed" }).waitFor();
  const deleteButton = page.getByRole("button", {
    name: "Delete Night renamed",
  });
  await deleteButton.click();
  const cancelDelete = page.getByRole("button", {
    exact: true,
    name: "Cancel",
  });
  await cancelDelete.waitFor();
  assert.equal(
    await cancelDelete.evaluate(
      (element) => element === document.activeElement
    ),
    true
  );
  await cancelDelete.click();
  assert.equal(
    await deleteButton.evaluate(
      (element) => element === document.activeElement
    ),
    true
  );
  await deleteButton.click();
  await page.getByRole("button", { name: "Delete set" }).click();
  await page.getByRole("heading", { name: "Start your collection" }).waitFor();
  const libraryHeading = page.getByRole("heading", { name: "Your library" });
  assert.equal(
    await libraryHeading.evaluate(
      (element) => element === document.activeElement
    ),
    true
  );
  await page.screenshot({
    fullPage: true,
    path: path.join(tmpdir(), "orbis-desktop-smoke.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    `Desktop smoke passed: save, search, source + tags, title and tag editing, reload, playlist membership, and deletion. Screenshot: ${path.join(tmpdir(), "orbis-desktop-smoke.png")}`
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error(await page.locator("body").textContent());
    await page.screenshot({
      fullPage: true,
      path: path.join(tmpdir(), "orbis-desktop-smoke-failure.png"),
    });
  }
  console.error(logs);
  throw error;
} finally {
  if (app) {
    await app.close();
  }
  server.kill("SIGTERM");
  await serverExit;
  await rm(directory, { force: true, recursive: true });
}
