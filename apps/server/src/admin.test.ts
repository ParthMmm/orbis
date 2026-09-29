import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

const call = (app: ReturnType<typeof createApp>, token: string, method: string, url: string, payload?: unknown) =>
  request(app, {
    accessMode: "device",
    headers: { authorization: `Bearer ${token}` },
    host: "vanta.example.ts.net",
    method,
    payload,
    url,
  });

test("admin keys manage People and revoke all of a removed Person's data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-admin-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  const trust = (...args: string[]) => Bun.spawnSync(
    [process.execPath, "src/trust.ts", ...args, "--devices", devicesPath],
    { cwd: path.resolve(import.meta.dir, "..") }
  );
  const adminSeed = trust("key", "add", "--person", "host", "--label", "recovery", "--scope", "admin");
  expect(adminSeed.exitCode).toBe(0);
  const admin = adminSeed.stdout.toString().match(/shown once: (?<token>\S+)/u)?.groups?.token;
  if (!admin) throw new Error("Missing admin token");
  const dailySeed = trust("key", "add", "--person", "host", "--label", "phone");
  const daily = dailySeed.stdout.toString().match(/shown once: (?<token>\S+)/u)?.groups?.token;
  if (!daily) throw new Error("Missing daily token");
  const app = createApp({ databasePath, devicesPath });
  try {
    for (const method of ["GET", "POST", "DELETE"]) {
      expect((await call(app, daily, method, "/admin/people", { username: "blocked" })).statusCode).toBe(403);
    }
    expect((await call(app, daily, "GET", "/admin/keys")).statusCode).toBe(403);
    const added = await call(app, admin, "POST", "/admin/people", { username: "alice" });
    expect(added.statusCode).toBe(201);
    const person = added.json() as { id: string; username: string };
    expect(person.username).toBe("alice");
    expect((await call(app, admin, "GET", "/admin/people")).json()).toMatchObject({ people: [
      { id: "host" }, { id: person.id, username: "alice" },
    ] });
    const minted = await call(app, admin, "POST", `/admin/people/${person.id}/keys`, { label: "Alice phone" });
    expect(minted.statusCode).toBe(201);
    const key = minted.json() as { id: string; token: string };
    expect(key.token).toBeString();
    expect((await call(app, key.token, "GET", "/me")).json()).toEqual(person);
    const keys = (await call(app, admin, "GET", `/admin/people/${person.id}/keys`)).json() as { keys: { id: string; lastUsedAt: string | null }[] };
    expect(keys.keys[0]).toMatchObject({ id: key.id, lastUsedAt: expect.any(String) });
    const before = keys.keys[0]?.lastUsedAt;
    await call(app, key.token, "GET", "/me");
    const after = (await call(app, admin, "GET", `/admin/people/${person.id}/keys`)).json() as typeof keys;
    expect(after.keys[0]?.lastUsedAt).toBe(before);
    expect((await readFile(devicesPath, "utf8")).includes(key.token)).toBe(false);
    expect((await call(app, admin, "DELETE", `/admin/keys/${key.id}`)).statusCode).toBe(200);
    expect((await call(app, key.token, "GET", "/me")).statusCode).toBe(401);

    const second = await call(app, admin, "POST", `/admin/people/${person.id}/keys`, { label: "Second" });
    const secondToken = (second.json() as { token: string }).token;
    const saved = await call(app, secondToken, "POST", "/sets", { url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(saved.statusCode).toBe(201);
    const setId = (saved.json() as { id: string }).id;
    const playlist = await call(app, secondToken, "POST", "/playlists", { name: "Alice picks" });
    expect(playlist.statusCode).toBe(201);
    expect((await call(app, secondToken, "PUT", `/sets/${setId}/position`, { seconds: 12 })).statusCode).toBe(200);
    expect((await call(app, secondToken, "PUT", "/queue/active", { setId })).statusCode).toBe(200);
    expect((await call(app, admin, "DELETE", `/admin/people/${person.id}`)).statusCode).toBe(200);
    expect((await call(app, secondToken, "GET", "/me")).statusCode).toBe(401);
    const db = new Database(databasePath);
    try {
      for (const table of ["library_entries", "playlists", "queue_entries", "playback_positions"]) {
        const column = table === "playlists" ? "creator_id" : "person_id";
        expect(db.query(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`).get(person.id)).toMatchObject({ count: 0 });
      }
    } finally {
      db.close();
    }
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
