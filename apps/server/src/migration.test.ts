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

// A frozen snapshot of the version-1 schema. Keep it literal: it describes the shape an
// existing database already has, not whatever the creator builds today.
const VERSION_ONE_SCHEMA = `PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sets (
     id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
     source TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL,
     creator TEXT, artwork_url TEXT, duration_seconds INTEGER,
     metadata_state TEXT NOT NULL DEFAULT 'pending',
     title_edited_by_user INTEGER NOT NULL DEFAULT 1,
     download_state TEXT NOT NULL DEFAULT 'none',
     retained_audio_bytes INTEGER, retained_audio_format TEXT,
     playback_position_seconds INTEGER NOT NULL DEFAULT 0,
     listen_count INTEGER NOT NULL DEFAULT 0,
     finish_count INTEGER NOT NULL DEFAULT 0, last_listened_at TEXT
    );
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playlist_sets (
     playlist_id TEXT NOT NULL REFERENCES playlists(id), set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
     PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
    );
    PRAGMA user_version = 1;`;

const REVERSE_INDEX = "playlist_sets_by_set";

interface FixtureOptions {
  readonly withReverseIndex?: boolean;
}

const writeVersionOneDatabase = (
  databasePath: string,
  options: FixtureOptions = {}
) => {
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(VERSION_ONE_SCHEMA);
    const insertSet = database.query(
      "INSERT INTO sets (id, url, title, source, tags, created_at, creator, title_edited_by_user, listen_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insertSet.run(
      "kept-set",
      "https://www.youtube.com/watch?v=uvwxyzabcde",
      "A kept title",
      "youtube",
      JSON.stringify(["techno"]),
      "2026-02-01T00:00:00.000Z",
      "Kept Channel",
      1,
      4
    );
    insertSet.run(
      "provider-set",
      "https://www.youtube.com/watch?v=fghijklmnop",
      "A placeholder title",
      "youtube",
      JSON.stringify([]),
      "2026-02-02T00:00:00.000Z",
      null,
      0,
      0
    );
    const insertPlaylist = database.query(
      "INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)"
    );
    insertPlaylist.run("first-playlist", "First", "2026-02-03T00:00:00.000Z");
    insertPlaylist.run("second-playlist", "Second", "2026-02-04T00:00:00.000Z");
    const insertMembership = database.query(
      "INSERT INTO playlist_sets (playlist_id, set_id, position) VALUES (?, ?, ?)"
    );
    insertMembership.run("first-playlist", "provider-set", 0);
    insertMembership.run("first-playlist", "kept-set", 1);
    insertMembership.run("second-playlist", "kept-set", 0);
    if (options.withReverseIndex) {
      database.exec(
        `CREATE INDEX ${REVERSE_INDEX} ON playlist_sets(set_id, playlist_id)`
      );
    }
  } finally {
    database.close();
  }
};

// A version-0 database: the base tables, no extended columns, and no version marker.
const writeVersionZeroDatabase = (databasePath: string) => {
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(LEGACY_SCHEMA);
    const insertSet = database.query(
      "INSERT INTO sets (id, url, title, source, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insertSet.run(
      "unmarked-set",
      "https://www.youtube.com/watch?v=qrstuvwxyza",
      "Saved before any version marker",
      "youtube",
      JSON.stringify(["house"]),
      "2026-03-01T00:00:00.000Z"
    );
    insertSet.run(
      "unmarked-other",
      "https://www.youtube.com/watch?v=bcdefghijkl",
      "Another unmarked set",
      "youtube",
      JSON.stringify([]),
      "2026-03-02T00:00:00.000Z"
    );
    database
      .query("INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)")
      .run("unmarked-playlist", "Unmarked", "2026-03-03T00:00:00.000Z");
    const insertMembership = database.query(
      "INSERT INTO playlist_sets (playlist_id, set_id, position) VALUES (?, ?, ?)"
    );
    insertMembership.run("unmarked-playlist", "unmarked-other", 0);
    insertMembership.run("unmarked-playlist", "unmarked-set", 1);
  } finally {
    database.close();
  }
};

interface SchemaState {
  readonly indexCount: number;
  readonly indexNames: readonly string[];
  readonly reverseIndexColumns: readonly string[];
  readonly version: number;
}

const readSchemaState = (databasePath: string): SchemaState => {
  const database = new Database(databasePath, { readonly: true });
  try {
    // SAFETY: SQLite returns one row with an integer user_version column on every build.
    const { user_version: version } = database
      .query("PRAGMA user_version")
      .get() as {
      user_version: number;
    };
    const indexes = database
      .query<{ name: string }, []>("PRAGMA index_list('playlist_sets')")
      .all();
    // Reading a missing index yields no rows rather than an error.
    const reverseIndexColumns = database
      .query<{ name: string }, []>(`PRAGMA index_info('${REVERSE_INDEX}')`)
      .all()
      .map((column) => column.name);
    return {
      indexCount: indexes.length,
      indexNames: indexes.map((index) => index.name),
      reverseIndexColumns,
      version,
    };
  } finally {
    database.close();
  }
};

const expectMigratedWithReverseIndex = (state: SchemaState) => {
  expect(state.version).toBe(2);
  expect(state.indexNames).toContain(REVERSE_INDEX);
  expect(state.reverseIndexColumns).toEqual(["set_id", "playlist_id"]);
};

// The correlated membership expression from SET_COLUMNS in library.ts. It is repeated here
// because the plan forbids exporting private SQL constants just to test them.
const MEMBERSHIP_LOOKUP_PLAN = `EXPLAIN QUERY PLAN
  SELECT (SELECT COALESCE(json_group_array(playlist_id ORDER BY playlist_id), '[]')
   FROM playlist_sets WHERE playlist_sets.set_id = sets.id) AS playlistIds
  FROM sets`;

test("creates the membership index for a fresh database", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toEqual({ sets: [] });
    } finally {
      await app.dispose();
    }
    expectMigratedWithReverseIndex(readSchemaState(databasePath));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("adds the membership index to a version-1 database without touching its data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    writeVersionOneDatabase(databasePath);
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toEqual({
        sets: [
          {
            artworkLargeUrl: null,
            artworkUrl: null,
            createdAt: "2026-02-02T00:00:00.000Z",
            creator: null,
            downloadState: "none",
            durationSeconds: null,
            finishCount: 0,
            id: "provider-set",
            lastListenedAt: null,
            listenCount: 0,
            metadataState: "pending",
            playbackPositionSeconds: 0,
            playlistIds: ["first-playlist"],
            retainedAudioBytes: null,
            retainedAudioFormat: null,
            source: "youtube",
            tags: [],
            title: "A placeholder title",
            titleEditedByUser: false,
            url: "https://www.youtube.com/watch?v=fghijklmnop",
          },
          {
            artworkLargeUrl: null,
            artworkUrl: null,
            createdAt: "2026-02-01T00:00:00.000Z",
            creator: "Kept Channel",
            downloadState: "none",
            durationSeconds: null,
            finishCount: 0,
            id: "kept-set",
            lastListenedAt: null,
            listenCount: 4,
            metadataState: "pending",
            playbackPositionSeconds: 0,
            playlistIds: ["first-playlist", "second-playlist"],
            retainedAudioBytes: null,
            retainedAudioFormat: null,
            source: "youtube",
            tags: ["techno"],
            title: "A kept title",
            titleEditedByUser: true,
            url: "https://www.youtube.com/watch?v=uvwxyzabcde",
          },
        ],
      });

      const ordered = await request(app, {
        method: "GET",
        url: "/sets?playlistId=first-playlist",
      });
      expect(ordered.statusCode).toBe(200);
      expect(ordered.json()).toMatchObject({
        sets: [{ id: "provider-set" }, { id: "kept-set" }],
      });

      const playlists = await request(app, {
        method: "GET",
        url: "/playlists",
      });
      expect(playlists.statusCode).toBe(200);
      expect(playlists.json()).toMatchObject({
        playlists: [
          { id: "first-playlist", setCount: 2 },
          { id: "second-playlist", setCount: 1 },
        ],
      });
    } finally {
      await app.dispose();
    }
    expectMigratedWithReverseIndex(readSchemaState(databasePath));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("adds the membership index to a database saved before any version marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    writeVersionZeroDatabase(databasePath);
    expect(readSchemaState(databasePath).version).toBe(0);
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toMatchObject({
        sets: [
          {
            creator: null,
            id: "unmarked-other",
            listenCount: 0,
            metadataState: "pending",
            playlistIds: ["unmarked-playlist"],
            titleEditedByUser: true,
          },
          {
            creator: null,
            id: "unmarked-set",
            listenCount: 0,
            metadataState: "pending",
            playlistIds: ["unmarked-playlist"],
            titleEditedByUser: true,
          },
        ],
      });
      const ordered = await request(app, {
        method: "GET",
        url: "/sets?playlistId=unmarked-playlist",
      });
      expect(ordered.json()).toMatchObject({
        sets: [{ id: "unmarked-other" }, { id: "unmarked-set" }],
      });
    } finally {
      await app.dispose();
    }
    expectMigratedWithReverseIndex(readSchemaState(databasePath));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps one membership index across reopens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    writeVersionOneDatabase(databasePath);
    let app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
    } finally {
      await app.dispose();
    }
    const first = readSchemaState(databasePath);
    expectMigratedWithReverseIndex(first);

    app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.json()).toMatchObject({
        sets: [{ id: "provider-set" }, { id: "kept-set" }],
      });
    } finally {
      await app.dispose();
    }
    const second = readSchemaState(databasePath);
    expectMigratedWithReverseIndex(second);
    expect(second.indexCount).toBe(first.indexCount);
    expect(
      second.indexNames.filter((name) => name === REVERSE_INDEX)
    ).toHaveLength(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("accepts a version-1 database that already carries the membership index", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    writeVersionOneDatabase(databasePath, { withReverseIndex: true });
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toMatchObject({
        sets: [{ id: "provider-set" }, { id: "kept-set" }],
      });
    } finally {
      await app.dispose();
    }
    const state = readSchemaState(databasePath);
    expectMigratedWithReverseIndex(state);
    expect(
      state.indexNames.filter((name) => name === REVERSE_INDEX)
    ).toHaveLength(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps title ownership after the membership index migration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    writeVersionOneDatabase(databasePath);
    const metadata = Metadata.layerOf({
      enrich: () =>
        Effect.succeed({
          artworkLargeUrl: null,
          artworkUrl: null,
          creator: "Some Channel",
          durationSeconds: 120,
          title: "The provider's title",
        }),
    });
    const first = createApp({ databasePath });
    try {
      const library = await request(first, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
    } finally {
      await first.dispose();
    }

    const app = createApp({ databasePath, metadata });
    try {
      const kept = await request(app, {
        method: "POST",
        url: "/sets/kept-set/metadata",
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json()).toMatchObject({
        title: "A kept title",
        titleEditedByUser: true,
      });

      const placeholder = await request(app, {
        method: "POST",
        url: "/sets/provider-set/metadata",
      });
      expect(placeholder.statusCode).toBe(200);
      expect(placeholder.json()).toMatchObject({
        title: "The provider's title",
        titleEditedByUser: false,
      });
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("looks up playlist ids through the membership index", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-migration-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.statusCode).toBe(200);
    } finally {
      await app.dispose();
    }
    const database = new Database(databasePath, { readonly: true });
    try {
      const details = database
        .query<{ detail: string }, []>(MEMBERSHIP_LOOKUP_PLAN)
        .all()
        .map((row) => row.detail);
      expect(
        details.some(
          (detail) =>
            detail.includes("SEARCH playlist_sets") &&
            detail.includes(REVERSE_INDEX)
        )
      ).toBe(true);
      expect(
        details.some((detail) => detail.includes("SCAN playlist_sets"))
      ).toBe(false);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

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
          artworkLargeUrl: null,
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
          artworkLargeUrl: null,
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
