import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const requireDesktop = createRequire(
	resolve(root, "apps/desktop/package.json")
);
const directory = await mkdtemp(join(tmpdir(), "orbis-smoke-"));
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
	let port;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(logs);
		port = /Orbis API: http:\/\/127\.0\.0\.1:(\d+)/.exec(logs)?.[1];
		if (port) break;
		await delay(100);
	}
	assert.ok(port, `Server did not start: ${logs}`);
	app = await electron.launch({
		executablePath: requireDesktop("electron"),
		args: [".vite/build/main.js"],
		cwd: resolve(root, "apps/desktop"),
		env: { ...process.env, ORBIS_PORT: port },
	});
	const page = await app.firstWindow();
	const errors = [];
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.error("Renderer:", error.message);
	});
	page.on("console", (message) => {
		if (message.type() === "error") console.error(message.text());
	});
	await page.reload();
	await page.getByRole("heading", { name: "Start your collection" }).waitFor();
	const form = page.getByRole("region", { name: "Save a set" });
	await form
		.getByLabel("YouTube or SoundCloud URL")
		.fill("https://youtu.be/abcdefghijk?t=30");
	await form.getByLabel("Title", { exact: true }).fill("Night session");
	await form.getByLabel("Tags", { exact: true }).fill("Techno");
	await form.getByRole("button", { name: "Add tag", exact: true }).click();
	await form.getByRole("button", { name: "Save set", exact: true }).click();
	await page.getByRole("link", { name: "Night session" }).waitFor();
	await page.getByLabel("Search", { exact: true }).fill("missing");
	await page.getByRole("heading", { name: "No matching sets" }).waitFor();
	await page.getByRole("button", { name: "Clear filters" }).click();
	await page.getByRole("checkbox", { name: "techno", exact: true }).check();
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
	await editor.getByRole("button", { name: "Add tag", exact: true }).click();
	await editor.getByRole("button", { name: "Save tags" }).click();
	await page.getByRole("heading", { name: "No matching sets" }).waitFor();
	await page.getByRole("button", { name: "Clear filters" }).click();
	await page.getByRole("checkbox", { name: "ambient", exact: true }).waitFor();
	await page.reload();
	await page.getByRole("link", { name: "Night session" }).waitFor();
	await page.getByLabel("New playlist", { exact: true }).fill("Evenings");
	await page.getByRole("button", { name: "Create", exact: true }).click();
	await page.getByRole("heading", { name: "This playlist is empty" }).waitFor();
	await page
		.getByLabel("Add a saved set", { exact: true })
		.selectOption({ label: "Night session" });
	await page
		.getByRole("button", { name: "Add to playlist", exact: true })
		.click();
	await page.getByRole("link", { name: "Night session" }).waitFor();
	await page
		.getByRole("button", {
			name: "Remove Night session from playlist",
			exact: true,
		})
		.click();
	await page.getByRole("heading", { name: "This playlist is empty" }).waitFor();
	await page.getByLabel("View", { exact: true }).selectOption("");
	await page.getByRole("link", { name: "Night session" }).waitFor();
	await page.screenshot({
		path: join(tmpdir(), "orbis-desktop-smoke.png"),
		fullPage: true,
	});
	assert.deepEqual(errors, []);
	console.log(
		`Desktop smoke passed: save, search, source + tags, tag editing, reload, playlist creation and membership. Screenshot: ${join(tmpdir(), "orbis-desktop-smoke.png")}`
	);
} catch (error) {
	if (app) {
		const page = await app.firstWindow();
		console.error(await page.locator("body").innerText());
		await page.screenshot({
			path: join(tmpdir(), "orbis-desktop-smoke-failure.png"),
			fullPage: true,
		});
	}
	console.error(logs);
	throw error;
} finally {
	if (app) await app.close();
	server.kill("SIGTERM");
	await serverExit;
	await rm(directory, { recursive: true, force: true });
}
