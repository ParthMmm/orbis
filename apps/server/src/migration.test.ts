import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createApp } from "./app.js";
import { Metadata } from "./metadata.js";
import { request } from "./test-http.js";

const LEGACY_SCHEMA = `PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sets (
     id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
     source TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playlist_sets (
     playlist_id TEXT NOT NULL REFERENCES playlists(id), set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
     PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
    );`;

const writeLegacyDatabase = (databasePath: string) => {
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(LEGACY_SCHEMA);
    database
      .query(
        "INSERT INTO sets (id, url, title, source, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        "legacy-set",
        "https://www.youtube.com/watch?v=abcdefghijk",
        "Saved before the extended columns",
        "youtube",
        JSON.stringify(["techno"]),
        "2026-01-01T00:00:00.000Z"
      );
    database
      .query("INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)")
      .run("legacy-playlist", "Long sets", "2026-01-01T00:00:00.000Z");
    database
      .query(
        "INSERT INTO playlist_sets (playlist_id, set_id, position) VALUES (?, ?, ?)"
      )
      .run("legacy-playlist", "legacy-set", 0);
  } finally {
    database.close();
  }
};

test("keeps sets and playlist membership saved before the extended columns existed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  writeLegacyDatabase(databasePath);
  const app = createApp({ databasePath });
  try {
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
    expect(library.json()).toEqual({
      sets: [
        {
          artworkUrl: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          creator: null,
          downloadState: "none",
          durationSeconds: null,
          finishCount: 0,
          id: "legacy-set",
          lastListenedAt: null,
          listenCount: 0,
          metadataState: "pending",
          playbackPositionSeconds: 0,
          playlistIds: ["legacy-playlist"],
          retainedAudioBytes: null,
          retainedAudioFormat: null,
          source: "youtube",
          tags: ["techno"],
          title: "Saved before the extended columns",
          titleEditedByUser: true,
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        },
      ],
    });

    const playlist = await request(app, {
      method: "GET",
      url: "/sets?playlistId=legacy-playlist",
    });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.json()).toMatchObject({ sets: [{ id: "legacy-set" }] });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("applies the extended columns once and keeps them on a later open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  let app = createApp({ databasePath });
  try {
    writeLegacyDatabase(databasePath);

    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: [],
        title: "Saved after migration",
        url: "https://www.youtube.com/watch?v=lmnopqrstuv",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    await app.dispose();
    app = createApp({ databasePath });

    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
    expect(library.json()).toMatchObject({
      sets: [
        { title: "Saved after migration" },
        { title: "Saved before the extended columns" },
      ],
    });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("does not replace the title of a set saved before the column existed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  writeLegacyDatabase(databasePath);
  const app = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      enrich: () =>
        Effect.succeed({
          artworkUrl: null,
          creator: "Some Channel",
          durationSeconds: 120,
          title: "The provider's title",
        }),
    }),
  });
  try {
    const retried = await request(app, {
      method: "POST",
      url: "/sets/legacy-set/metadata",
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      creator: "Some Channel",
      title: "Saved before the extended columns",
      titleEditedByUser: true,
    });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
