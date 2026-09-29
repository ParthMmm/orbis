import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

const call = (
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  url: string,
  payload?: { [key: string]: string | number | string[] }
) =>
  request(app, {
    accessMode: "device",
    headers: { authorization: `Bearer ${token}` },
    host: "vanta.example.ts.net",
    method,
    payload,
    url,
  });

const status = async (...args: Parameters<typeof call>) => {
  const response = await call(...args);
  return response.statusCode;
};

const body = async (...args: Parameters<typeof call>) => {
  const response = await call(...args);
  return response.json();
};

test("admin keys manage People and revoke all of a removed Person's data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-admin-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  const trust = (...args: string[]) =>
    Bun.spawnSync(
      [process.execPath, "src/trust.ts", ...args, "--devices", devicesPath],
      { cwd: path.resolve(import.meta.dir, "..") }
    );
  const adminSeed = trust(
    "key",
    "add",
    "--person",
    "host",
    "--label",
    "recovery",
    "--scope",
    "admin"
  );
  expect(adminSeed.exitCode).toBe(0);
  const admin = adminSeed.stdout.toString().match(/shown once: (?<token>\S+)/u)
    ?.groups?.token;
  if (!admin) {
    throw new Error("Missing admin token");
  }
  const dailySeed = trust("key", "add", "--person", "host", "--label", "phone");
  const daily = dailySeed.stdout.toString().match(/shown once: (?<token>\S+)/u)
    ?.groups?.token;
  if (!daily) {
    throw new Error("Missing daily token");
  }
  let app = createApp({ databasePath, devicesPath });
  try {
    const denied = await Promise.all([
      status(app, daily, "GET", "/admin/people"),
      status(app, daily, "POST", "/admin/people", { username: "blocked" }),
      status(app, daily, "DELETE", "/admin/people/someone"),
      status(app, daily, "GET", "/admin/keys"),
      status(app, daily, "GET", "/admin/people/someone/keys"),
      status(app, daily, "POST", "/admin/people/someone/keys", {
        label: "blocked",
      }),
      status(app, daily, "DELETE", "/admin/keys/some-key"),
    ]);
    expect(denied).toEqual([403, 403, 403, 403, 403, 403, 403]);
    const localAdmin = await request(app, {
      method: "GET",
      url: "/admin/people",
    });
    expect(localAdmin.statusCode).toBe(403);
    const beforeBypass = await body(app, admin, "GET", "/admin/people");
    const keysBeforeBypass = await body(app, admin, "GET", "/admin/keys");
    const variantAttempts = await Promise.all(
      ["/%61dmin", "//admin", "/ADMIN"].map((prefix) =>
        Promise.all([
          status(app, daily, "GET", `${prefix}/people`),
          status(app, daily, "POST", `${prefix}/people`, {
            username: `blocked-${prefix.length}`,
          }),
          status(app, daily, "POST", `${prefix}/people`, {}),
          status(app, daily, "DELETE", `${prefix}/people/host`),
          status(app, daily, "GET", `${prefix}/keys`),
          status(app, daily, "GET", `${prefix}/people/host/keys`),
          status(app, daily, "POST", `${prefix}/people/host/keys`, {
            label: "bypass",
            scope: "admin",
          }),
          status(app, daily, "POST", `${prefix}/people/host/keys`, {}),
          status(app, daily, "DELETE", `${prefix}/keys/missing`),
        ])
      )
    );
    for (const attempts of variantAttempts) {
      expect(attempts).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
    }
    const malformed = await app.handler(
      new Request("http://vanta.example.ts.net/%61dmin/people", {
        body: "{",
        headers: {
          authorization: `Bearer ${daily}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
      "device"
    );
    expect(malformed.status).toBe(403);
    expect(await body(app, admin, "GET", "/admin/people")).toEqual(
      beforeBypass
    );
    const keysAfterBypass = await body(app, admin, "GET", "/admin/keys");
    expect(keysAfterBypass.keys.map((key: { id: string }) => key.id)).toEqual(
      keysBeforeBypass.keys.map((key: { id: string }) => key.id)
    );
    expect(await status(app, admin, "POST", "/admin/people", {})).toBe(400);
    const added = await call(app, admin, "POST", "/admin/people", {
      username: "alice",
    });
    expect(added.statusCode).toBe(201);
    const person = added.json();
    expect(person.username).toBe("alice");
    expect(await body(app, admin, "GET", "/admin/people")).toMatchObject({
      people: [{ id: "host" }, { id: person.id, username: "alice" }],
    });
    expect(
      await status(app, admin, "POST", `/admin/people/${person.id}/keys`, {
        label: "invalid admin",
        scope: "admin",
      })
    ).toBe(400);
    const minted = await call(
      app,
      admin,
      "POST",
      `/admin/people/${person.id}/keys`,
      { label: "Alice phone" }
    );
    expect(minted.statusCode).toBe(201);
    const key = minted.json();
    expect(key.token).toBeString();
    expect(await body(app, key.token, "GET", "/me")).toEqual({
      ...person,
      autoDownload: true,
      social: false,
    });
    const keys = await body(
      app,
      admin,
      "GET",
      `/admin/people/${person.id}/keys`
    );
    expect(keys.keys[0]?.id).toBe(key.id);
    expect(keys.keys[0]?.scope).toBe("daily");
    expect(keys.keys[0]?.lastUsedAt).toBeString();
    const before = keys.keys[0]?.lastUsedAt;
    await call(app, key.token, "GET", "/me");
    const after = await body(
      app,
      admin,
      "GET",
      `/admin/people/${person.id}/keys`
    );
    expect(after.keys[0]?.lastUsedAt).toBe(before);
    const storeText = await readFile(devicesPath, "utf-8");
    expect(storeText.includes(key.token)).toBe(false);
    expect(await status(app, admin, "DELETE", `/admin/keys/${key.id}`)).toBe(
      200
    );
    expect(await status(app, key.token, "GET", "/me")).toBe(401);

    const second = await call(
      app,
      admin,
      "POST",
      `/admin/people/${person.id}/keys`,
      { label: "Second" }
    );
    const secondToken = second.json().token;
    const saved = await call(app, secondToken, "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    expect(saved.statusCode).toBe(201);
    const setId = saved.json().id;
    const playlist = await call(app, secondToken, "POST", "/playlists", {
      name: "Alice picks",
    });
    expect(playlist.statusCode).toBe(201);
    const playlistId = playlist.json().id;
    expect(
      await status(app, secondToken, "PUT", `/playlists/${playlistId}/sets`, {
        setIds: [setId],
      })
    ).toBe(200);
    expect(
      await status(app, secondToken, "PUT", `/sets/${setId}/position`, {
        seconds: 12,
      })
    ).toBe(200);
    const seeded = new Database(databasePath);
    try {
      seeded
        .query("UPDATE sets SET download_state = 'queued' WHERE id = ?")
        .run(setId);
      seeded
        .query(
          "INSERT OR IGNORE INTO download_requesters (person_id) VALUES (?)"
        )
        .run(person.id);
      seeded
        .query(
          "INSERT OR IGNORE INTO download_jobs (person_id, set_id) VALUES (?, ?)"
        )
        .run(person.id, setId);
      expect(
        seeded
          .query(
            "SELECT person_id AS personId FROM download_jobs WHERE set_id = ?"
          )
          .get(setId)
      ).toMatchObject({ personId: person.id });
      seeded
        .query(
          "INSERT INTO queue_entries (person_id, set_id, position, is_active) VALUES (?, ?, 0, 0)"
        )
        .run(person.id, setId);
      seeded
        .query(
          "INSERT INTO listens (person_id, set_id, started_at, start_known) VALUES (?, ?, ?, 1)"
        )
        .run(person.id, setId, new Date().toISOString());
    } finally {
      seeded.close();
    }
    expect(
      await status(app, admin, "DELETE", `/admin/people/${person.id}`)
    ).toBe(200);
    expect(await status(app, secondToken, "GET", "/me")).toBe(401);
    await app.dispose();
    app = createApp({ databasePath, devicesPath });
    expect(await status(app, admin, "GET", "/me")).toBe(200);
    const afterRestart = new Database(databasePath);
    try {
      expect(
        afterRestart
          .query("SELECT download_state AS state FROM sets WHERE id = ?")
          .get(setId)
      ).toMatchObject({ state: "none" });
      expect(
        afterRestart
          .query("SELECT count(*) AS count FROM download_jobs WHERE set_id = ?")
          .get(setId)
      ).toMatchObject({ count: 0 });
    } finally {
      afterRestart.close();
    }
    const rotated = await call(app, admin, "POST", "/admin/people/host/keys", {
      label: "new recovery",
      scope: "admin",
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedKey = rotated.json();
    expect(rotatedKey.scope).toBe("admin");
    const allKeys = await body(app, rotatedKey.token, "GET", "/admin/keys");
    expect(
      allKeys.keys.some(
        (candidate: { id: string }) => candidate.id === rotatedKey.id
      )
    ).toBe(true);
    const oldAdmin = allKeys.keys.find(
      (candidate: { label: string }) => candidate.label === "recovery"
    );
    expect(
      await status(
        app,
        rotatedKey.token,
        "DELETE",
        `/admin/keys/${oldAdmin.id}`
      )
    ).toBe(200);
    expect(await status(app, admin, "GET", "/admin/people")).toBe(401);
    expect(await status(app, rotatedKey.token, "GET", "/admin/people")).toBe(
      200
    );
    const db = new Database(databasePath);
    try {
      for (const table of [
        "library_entries",
        "playlists",
        "queue_entries",
        "playback_positions",
        "listens",
      ]) {
        const column = table === "playlists" ? "creator_id" : "person_id";
        expect(
          db
            .query(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`)
            .get(person.id)
        ).toMatchObject({ count: 0 });
      }
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM playlist_sets WHERE playlist_id = ?"
          )
          .get(playlistId)
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
