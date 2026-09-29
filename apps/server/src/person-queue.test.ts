import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

const token = "person-b-queue-test";
type Payload =
  | { readonly setId: string }
  | { readonly seconds: number }
  | { readonly placement: "end"; readonly setId: string };
const asB = (method: string, url: string, payload?: Payload) => ({
  accessMode: "device" as const,
  headers: { authorization: `Bearer ${token}` },
  host: "vanta.example.ts.net",
  method,
  payload,
  url,
});

const writePreviousDatabase = (databasePath: string) => {
  const database = new Database(databasePath, { create: true });
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
    }).filter(
      (migration) => migration.name <= "20260928140000_library_entries"
    );
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at numeric,
        name TEXT, applied_at TEXT
      );
    `);
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        if (statement.trim()) {
          database.exec(statement);
        }
      }
      database
        .query(
          "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"
        )
        .run(migration.hash, migration.folderMillis, migration.name);
    }
    database.exec("PRAGMA user_version = 2");
    const insertSet = database.query(`
      INSERT INTO sets (id, url, title, source, tags, created_at,
        download_state, retained_audio_format, playback_position_seconds)
      VALUES (?, ?, ?, 'youtube', '[]', '2026-01-01T00:00:00.000Z',
        'ready', 'm4a', ?)
    `);
    insertSet.run("a", "https://www.youtube.com/watch?v=abcdefghijk", "A", 37);
    insertSet.run("b", "https://www.youtube.com/watch?v=bcdefghijkl", "B", 8);
    database.exec(`
      INSERT INTO library_entries (person_id, set_id, saved_at, tags)
      VALUES ('host', 'a', '2026-01-01T00:00:00.000Z', '[]'),
             ('host', 'b', '2026-01-01T00:00:00.000Z', '[]');
      INSERT INTO queue_entries (set_id, position, is_active)
      VALUES ('a', 0, 1), ('b', 1, 0);
    `);
  } finally {
    database.close();
  }
};

test("migrates Host playback and keeps two People independent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-person-queue-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  writePreviousDatabase(databasePath);
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "b-key",
          label: "B phone",
          lastUsedAt: null,
          personId: "b",
          scope: "daily",
          tokenHash: hashToken(token),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "b", removed: false, username: "b" },
      ],
      version: 2,
    })
  );
  const app = createApp({ databasePath, devicesPath });
  try {
    const hostQueue = await request(app, { method: "GET", url: "/queue" });
    expect(hostQueue.json().queue.activeSetId).toBe("a");
    expect(
      hostQueue.json().queue.entries.map((set: { id: string }) => set.id)
    ).toEqual(["a", "b"]);
    expect(hostQueue.json().queue.entries[0].playbackPositionSeconds).toBe(37);
    const emptyB = await request(app, asB("GET", "/queue"));
    expect(emptyB.json().queue).toEqual({ activeSetId: null, entries: [] });

    const bPlay = await request(
      app,
      asB("PUT", "/queue/active", { setId: "b" })
    );
    expect(bPlay.statusCode).toBe(200);
    expect(bPlay.json().queue.activeSetId).toBe("b");
    const bPosition = await request(
      app,
      asB("PUT", "/sets/a/position", { seconds: 91 })
    );
    expect(bPosition.statusCode).toBe(200);
    expect(bPosition.json().playbackPositionSeconds).toBe(91);
    const bQueuedA = await request(
      app,
      asB("POST", "/queue/entries", { placement: "end", setId: "a" })
    );
    expect(bQueuedA.statusCode).toBe(201);
    expect(bQueuedA.json().queue.entries[1].playbackPositionSeconds).toBe(91);

    const hostAfterB = await request(app, { method: "GET", url: "/queue" });
    expect(hostAfterB.json().queue.activeSetId).toBe("a");
    expect(hostAfterB.json().queue.entries[0].playbackPositionSeconds).toBe(37);
    expect(
      hostAfterB.json().queue.entries.map((set: { id: string }) => set.id)
    ).toEqual(["a", "b"]);
    const positions = new Database(databasePath);
    try {
      expect(
        positions
          .query(
            "SELECT person_id, set_id FROM queue_entries WHERE is_active = 1 ORDER BY person_id"
          )
          .all()
      ).toEqual([
        { person_id: "b", set_id: "b" },
        { person_id: "host", set_id: "a" },
      ]);
    } finally {
      positions.close();
    }
    const bCompleted = await request(
      app,
      asB("POST", "/queue/completion", { setId: "b" })
    );
    expect(bCompleted.statusCode).toBe(200);
    expect(bCompleted.json().queue.activeSetId).toBe("a");
    const hostAfterBCompletion = await request(app, {
      method: "GET",
      url: "/queue",
    });
    expect(hostAfterBCompletion.json().queue.activeSetId).toBe("a");
    expect(
      hostAfterBCompletion.json().queue.entries[1].playbackPositionSeconds
    ).toBe(8);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
