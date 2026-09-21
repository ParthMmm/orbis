import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createApp } from "./app.js";
import { backfillArtwork } from "./artwork.js";
import { layer as databaseLayer } from "./db/database.js";
import { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import { request } from "./test-http.js";

const OLD_SET_URL = "https://www.youtube.com/watch?v=oldoldoldol";
const COMPLETE_SET_URL = "https://www.youtube.com/watch?v=newnewnewne";
const UNNAMED_SET_URL = "https://www.youtube.com/watch?v=pendingpend";

const migrationsFolder = path.resolve(import.meta.dir, "../drizzle");

/// A library written before artwork came in two sizes: one Set holding only the listing
/// image, one holding both already, and one whose metadata never arrived.
const seedLibrary = async (databasePath: string) => {
  const app = createApp({ databasePath });
  try {
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
  } finally {
    await app.dispose();
  }

  const database = new Database(databasePath);
  try {
    const insert = database.query(
      `INSERT INTO sets
        (id, url, title, source, tags, created_at, title_edited_by_user, metadata_state,
         artwork_url, artwork_large_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    );
    insert.run(
      "old-set",
      OLD_SET_URL,
      "Named set",
      "youtube",
      "[]",
      "2026-02-01T00:00:00.000Z",
      "enriched",
      "https://example.test/hqdefault.jpg",
      null
    );
    insert.run(
      "complete-set",
      COMPLETE_SET_URL,
      "Named set",
      "youtube",
      "[]",
      "2026-02-01T00:00:00.000Z",
      "enriched",
      "https://example.test/mqdefault.jpg",
      "https://example.test/maxresdefault.jpg"
    );
    insert.run(
      "unnamed-set",
      UNNAMED_SET_URL,
      "YouTube video",
      "youtube",
      "[]",
      "2026-02-01T00:00:00.000Z",
      "pending",
      null,
      null
    );
  } finally {
    database.close();
  }
};

const readImages = (databasePath: string) => {
  const database = new Database(databasePath);
  try {
    return database
      .query<
        { artwork_large_url: string | null; artwork_url: string | null },
        []
      >("SELECT artwork_url, artwork_large_url FROM sets WHERE id = 'old-set'")
      .get();
  } finally {
    database.close();
  }
};

const runBackfill = (databasePath: string, asked: string[]) =>
  Effect.runPromise(
    backfillArtwork.pipe(
      Effect.provide(
        Metadata.layerOf({
          enrich: (input) =>
            Effect.sync(() => {
              asked.push(input.url);
              return {
                artworkLargeUrl: "https://example.test/large.jpg",
                artworkUrl: "https://example.test/listing.jpg",
                creator: "Ada Lovelace",
                durationSeconds: 253,
                title: "The provider's title",
              };
            }),
        })
      ),
      Effect.provide(databaseLayer({ databasePath, migrationsFolder }))
    )
  );

test("fills both images on a Set that holds only one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-artwork-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedLibrary(databasePath);
    const asked: string[] = [];

    expect(await runBackfill(databasePath, asked)).toEqual({
      attempted: 1,
      filled: 1,
    });
    // The Set that holds both is not asked about again, and a Set whose metadata never
    // arrived is left for the retry action that owns it.
    expect(asked).toEqual([OLD_SET_URL]);
    expect(readImages(databasePath)).toEqual({
      artwork_large_url: "https://example.test/large.jpg",
      artwork_url: "https://example.test/listing.jpg",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("leaves nothing to do on a second run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-artwork-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedLibrary(databasePath);
    await runBackfill(databasePath, []);

    const asked: string[] = [];
    expect(await runBackfill(databasePath, asked)).toEqual({
      attempted: 0,
      filled: 0,
    });
    expect(asked).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the images a Set has when the provider cannot answer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-artwork-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedLibrary(databasePath);

    const result = await Effect.runPromise(
      backfillArtwork.pipe(
        Effect.provide(
          Metadata.layerOf({
            enrich: () =>
              Effect.fail(
                new MetadataError({
                  message: "The provider is unreachable.",
                  reason: "provider-unavailable",
                })
              ),
          })
        ),
        Effect.provide(databaseLayer({ databasePath, migrationsFolder }))
      )
    );

    expect(result).toEqual({ attempted: 1, filled: 0 });
    expect(readImages(databasePath)).toEqual({
      artwork_large_url: null,
      artwork_url: "https://example.test/hqdefault.jpg",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
