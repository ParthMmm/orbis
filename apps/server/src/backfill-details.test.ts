import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";

import { backfillDetails } from "./backfill-details.js";
import { layer as databaseLayer } from "./db/database.js";
import { detachedJournal } from "./journal.js";
import { Library } from "./library.js";
import { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import type { SourceDetails } from "./ytdlp-metadata.js";

const migrationsFolder = path.resolve(import.meta.dir, "../drizzle");
const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;

const DETAILS: SourceDetails = {
  chapters: [],
  creator: "Ada Lovelace",
  creatorId: "UCada",
  creatorUrl: "https://www.youtube.com/@ada",
  description: "A mix.",
  durationSeconds: 253,
  genre: "House",
  releasedAt: null,
  tags: ["house", "deep"],
  thumbnailUrl: null,
  title: "A mix",
};

/// Three Sets: one without details, one that will fail, one that already has them.
const seed = async (databasePath: string) => {
  const app = createApp({ databasePath });
  try {
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
  } finally {
    await app.dispose();
  }
  const database = new Sqlite(databasePath);
  try {
    const insert = database.query(
      `INSERT INTO sets
        (id, url, title, source, tags, created_at, title_edited_by_user, metadata_state, source_tags, details_state)
       VALUES (?, ?, 'Named', 'youtube', '[]', '2026-02-01T00:00:00.000Z', 1, 'enriched', ?, ?)`
    );
    insert.run("needs", url("needsneeds1"), null, "pending");
    insert.run("fails", url("failsfails1"), null, "failed");
    insert.run("done", url("donedone111"), "[]", "filled");
  } finally {
    database.close();
  }
};

const readTags = (databasePath: string) => {
  const database = new Sqlite(databasePath);
  try {
    return database
      .query<{ id: string; source_tags: string | null }, []>(
        "SELECT id, source_tags FROM sets ORDER BY id"
      )
      .all();
  } finally {
    database.close();
  }
};

test("fills missing details, continues past a failure, and skips finished Sets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-details-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seed(databasePath);
    const asked: string[] = [];
    const database = databaseLayer({ databasePath, migrationsFolder });
    const layers = Layer.mergeAll(
      Library.layer.pipe(Layer.provide(detachedJournal())),
      Metadata.layerOf({
        details: (input) => {
          asked.push(input.url);
          return input.url === url("failsfails1")
            ? Effect.fail(
                new MetadataError({
                  message: "unreachable",
                  reason: "provider-unavailable",
                })
              )
            : Effect.succeed(DETAILS);
        },
        enrich: () => Effect.die("enrich is not used"),
      })
    ).pipe(Layer.provideMerge(database));

    const result = await Effect.runPromise(
      backfillDetails({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );

    expect(result).toEqual({ attempted: 2, filled: 1 });
    expect(asked).toEqual([url("needsneeds1"), url("failsfails1")]);
    expect(readTags(databasePath)).toEqual([
      { id: "done", source_tags: "[]" },
      { id: "fails", source_tags: null },
      { id: "needs", source_tags: JSON.stringify(["house", "deep"]) },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
