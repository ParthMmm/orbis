import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { request } from "./test-http.js";

const SOURCE_URL = "https://www.youtube.com/watch?v=abcdefghijk";
const B_TOKEN = "person-b-test-token";
type RemotePayload =
  | { readonly url: string; readonly tags?: string[] }
  | { readonly title: string }
  | { readonly tags: string[] };
const remote = (method: string, url: string, payload?: RemotePayload) => ({
  accessMode: "device" as const,
  headers: { authorization: `Bearer ${B_TOKEN}` },
  host: "vanta.example.ts.net",
  method,
  payload,
  url,
});

const writeLegacyLibrary = (databasePath: string) => {
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sets (
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
      CREATE TABLE playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE playlist_sets (
        playlist_id TEXT NOT NULL REFERENCES playlists(id),
        set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
      );
      PRAGMA user_version = 1;
    `);
    database
      .query(`
      INSERT INTO sets
        (id, url, title, source, tags, created_at, title_edited_by_user,
         download_state, retained_audio_bytes, retained_audio_format)
      VALUES (?, ?, ?, 'youtube', ?, ?, 1, 'ready', 1234, 'm4a')
    `)
      .run(
        "shared-set",
        SOURCE_URL,
        "Host edit",
        '["host-tag"]',
        "2026-01-01T00:00:00.000Z"
      );
    database.exec(`
      INSERT INTO playlists (id, name, created_at)
      VALUES ('host-playlist', 'Host playlist', '2026-01-01T00:00:00.000Z');
      INSERT INTO playlist_sets (playlist_id, set_id, position)
      VALUES ('host-playlist', 'shared-set', 0);
    `);
  } finally {
    database.close();
  }
};

test("legacy Host entry migrates and two People keep separate Library state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-entries-"));
  const databasePath = path.join(directory, "library.sqlite");
  const devicesPath = path.join(directory, "devices.json");
  writeLegacyLibrary(databasePath);
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
          tokenHash: hashToken(B_TOKEN),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "b", removed: false, username: "b" },
      ],
      version: 2,
    })
  );
  let providerTitle = "Provider first title";
  const app = createApp({
    databasePath,
    devicesPath,
    metadata: Metadata.layerOf({
      enrich: () =>
        Effect.succeed({
          artworkLargeUrl: null,
          artworkUrl: null,
          creator: "Shared artist",
          durationSeconds: 200,
          releasedAt: null,
          title: providerTitle,
        }),
    }),
  });
  try {
    const host = await request(app, { method: "GET", url: "/sets" });
    expect(host.statusCode).toBe(200);
    const migrated = new Database(databasePath);
    try {
      const entry = migrated
        .query(
          "SELECT title_override, tags FROM library_entries WHERE person_id = 'host' AND set_id = 'shared-set'"
        )
        .get();
      expect(entry).toEqual({
        tags: '["host-tag"]',
        title_override: "Host edit",
      });
    } finally {
      migrated.close();
    }
    expect(host.json().sets).toMatchObject([
      {
        downloadState: "ready",
        id: "shared-set",
        tags: ["host-tag"],
        title: "Host edit",
        titleEditedByUser: true,
      },
    ]);
    const empty = await request(app, remote("GET", "/sets"));
    expect(empty.json()).toEqual({ sets: [] });
    const deniedGets = await Promise.all(
      ["/sets/shared-set/audio", "/sets/shared-set/audio/state"].map((url) =>
        request(app, remote("GET", url))
      )
    );
    for (const denied of deniedGets) {
      expect(denied.statusCode).toBe(404);
    }
    const deniedDownloads = await Promise.all(
      (["POST", "DELETE"] as const).map((method) =>
        request(app, remote(method, "/sets/shared-set/audio/download"))
      )
    );
    for (const denied of deniedDownloads) {
      expect(denied.statusCode).toBe(404);
    }
    const deniedGrant = await request(
      app,
      remote("POST", "/sets/shared-set/audio/grant")
    );
    expect(deniedGrant.statusCode).toBe(404);
    const hostStillReady = await request(app, { method: "GET", url: "/sets" });
    expect(hostStillReady.json().sets[0]).toMatchObject({
      downloadState: "ready",
      retainedAudioBytes: 1234,
    });

    const saved = await request(
      app,
      remote("POST", "/sets", {
        tags: ["b-tag"],
        url: SOURCE_URL,
      })
    );
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      downloadState: "ready",
      id: "shared-set",
      retainedAudioBytes: 1234,
      tags: ["b-tag"],
      title: "Provider first title",
    });
    const renamed = await request(
      app,
      remote("PATCH", "/sets/shared-set/title", {
        title: "B edit",
      })
    );
    expect(renamed.json()).toMatchObject({ tags: ["b-tag"], title: "B edit" });
    const retagged = await request(
      app,
      remote("PATCH", "/sets/shared-set/tags", {
        tags: ["b-new"],
      })
    );
    expect(retagged.json().tags).toEqual(["b-new"]);
    const bTags = await request(app, remote("GET", "/tags"));
    expect(bTags.json()).toEqual({ tags: ["b-new"] });
    const hostTags = await request(app, { method: "GET", url: "/tags" });
    expect(hostTags.json()).toEqual({ tags: ["host-tag"] });
    const bSearch = await request(
      app,
      remote("GET", "/sets?q=B%20edit&tag=b-new")
    );
    expect(bSearch.json().sets.map((set: { id: string }) => set.id)).toEqual([
      "shared-set",
    ]);
    const hostSearch = await request(app, {
      method: "GET",
      url: "/sets?q=B%20edit",
    });
    expect(hostSearch.json()).toEqual({ sets: [] });
    const hostAfterRename = await request(app, { method: "GET", url: "/sets" });
    expect(hostAfterRename.json().sets[0]).toMatchObject({
      tags: ["host-tag"],
      title: "Host edit",
    });

    const secondUrl = "https://www.youtube.com/watch?v=uvwxyzabcde";
    const hostUnedited = await request(app, {
      method: "POST",
      payload: { url: secondUrl },
      url: "/sets",
    });
    expect(hostUnedited.json()).toMatchObject({
      title: "Provider first title",
      titleEditedByUser: false,
    });
    const bUnedited = await request(
      app,
      remote("POST", "/sets", { url: secondUrl })
    );
    expect(bUnedited.json()).toMatchObject({
      id: hostUnedited.json().id,
      title: "Provider first title",
      titleEditedByUser: false,
    });
    providerTitle = "Provider retry title";
    const bRetry = await request(
      app,
      remote("POST", `/sets/${hostUnedited.json().id}/metadata`)
    );
    expect(bRetry.json().title).toBe("Provider retry title");
    const hostAfterRetry = await request(app, { method: "GET", url: "/sets" });
    expect(
      hostAfterRetry
        .json()
        .sets.find((set: { id: string }) => set.id === hostUnedited.json().id)
        ?.title
    ).toBe("Provider retry title");

    const retried = await request(
      app,
      remote("POST", "/sets/shared-set/metadata")
    );
    expect(retried.statusCode).toBe(200);
    expect(retried.json().title).toBe("B edit");
    const removed = await request(app, remote("DELETE", "/sets/shared-set"));
    expect(removed.statusCode).toBe(200);
    const bFinal = await request(app, remote("GET", "/sets"));
    expect(bFinal.json().sets.map((set: { id: string }) => set.id)).toEqual([
      hostUnedited.json().id,
    ]);
    const hostFinal = await request(app, { method: "GET", url: "/sets" });
    expect(
      hostFinal
        .json()
        .sets.find((set: { id: string }) => set.id === "shared-set")
    ).toMatchObject({
      downloadState: "ready",
      id: "shared-set",
      tags: ["host-tag"],
      title: "Host edit",
    });
    const hostRemoved = await request(app, {
      method: "DELETE",
      url: "/sets/shared-set",
    });
    expect(hostRemoved.statusCode).toBe(200);
    const hostWithoutEntry = await request(app, {
      method: "GET",
      url: "/sets",
    });
    expect(
      hostWithoutEntry.json().sets.map((set: { id: string }) => set.id)
    ).not.toContain("shared-set");
    const retained = new Database(databasePath);
    try {
      expect(
        retained.query("SELECT id FROM sets WHERE id = 'shared-set'").get()
      ).toEqual({ id: "shared-set" });
      expect(
        retained
          .query("SELECT set_id FROM playlist_sets WHERE set_id = 'shared-set'")
          .get()
      ).toEqual({ set_id: "shared-set" });
    } finally {
      retained.close();
    }
    const bOnly = await request(
      app,
      remote("POST", "/sets", {
        url: "https://www.youtube.com/watch?v=bcdefghijkl",
      })
    );
    expect(bOnly.statusCode).toBe(201);
    const bOnlyId: string = bOnly.json().id;
    const queued = new Database(databasePath);
    try {
      queued
        .query(
          "INSERT INTO queue_entries (set_id, position, is_active) VALUES (?, 0, 0)"
        )
        .run(bOnlyId);
    } finally {
      queued.close();
    }
    const bOnlyRemoved = await request(
      app,
      remote("DELETE", `/sets/${bOnlyId}`)
    );
    expect(bOnlyRemoved.statusCode).toBe(200);
    const hostAfterBRemove = await request(app, {
      method: "GET",
      url: "/sets",
    });
    expect(
      hostAfterBRemove.json().sets.map((set: { id: string }) => set.id)
    ).not.toContain(bOnlyId);
    const hostCannotEditBOnly = await request(app, {
      method: "PATCH",
      payload: { title: "Host claim" },
      url: `/sets/${bOnlyId}/title`,
    });
    expect(hostCannotEditBOnly.statusCode).toBe(404);
    const stillQueued = new Database(databasePath);
    try {
      expect(
        stillQueued
          .query("SELECT set_id FROM queue_entries WHERE set_id = ?")
          .get(bOnlyId)
      ).toEqual({ set_id: bOnlyId });
    } finally {
      stillQueued.close();
    }
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
