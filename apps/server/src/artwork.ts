import { and, eq, isNull } from "drizzle-orm";
import { Effect, Result } from "effect";

import { Database } from "./db/database.js";
import { sets } from "./db/schema.js";
import { Metadata } from "./metadata.js";

export const backfillArtwork = Effect.gen(function* backfillArtworkEffect() {
  const db = yield* Database;
  const metadata = yield* Metadata;

  const rows = yield* db
    .select({ id: sets.id, source: sets.source, url: sets.url })
    .from(sets)
    .where(
      and(eq(sets.metadataState, "enriched"), isNull(sets.artworkLargeUrl))
    );

  const results = yield* Effect.forEach((row: (typeof rows)[number]) =>
    Effect.gen(function* fillOne() {
      const image = yield* metadata.enrich({
        source: row.source,
        url: row.url,
      });
      yield* db
        .update(sets)
        .set({
          artworkLargeUrl: image.artworkLargeUrl,
          artworkUrl: image.artworkUrl,
        })
        .where(eq(sets.id, row.id));
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Kept the images on ${row.id}: ${error.message}`)
      ),
      Effect.result
    )
  )(rows);

  return {
    attempted: rows.length,
    filled: results.filter((result) => Result.isSuccess(result)).length,
  };
});
