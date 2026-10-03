import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { downloadJobs, setCues, sets } from "./db/schema.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";

const releaseError = <E>(error: E) =>
  error instanceof LibraryError
    ? error
    : new LibraryError({
        message: "Could not release audio.",
        statusCode: 500,
      });

export const releaseAudio = (
  id: string,
  removeFiles: (id: string) => Effect.Effect<void, LibraryError> = () =>
    Effect.void
) =>
  Effect.gen(function* releaseStoredAudio() {
    const db = yield* Database;
    yield* db.transaction((tx) =>
      Effect.gen(function* releaseUnreferencedAudio() {
        const [reference] = yield* tx.all<{ readonly present: number }>(sql`
          SELECT 1 AS present FROM library_entries WHERE set_id = ${id}
          UNION ALL SELECT 1 AS present FROM playlist_sets WHERE set_id = ${id}
          UNION ALL SELECT 1 AS present FROM queue_entries WHERE set_id = ${id}
          LIMIT 1
        `);
        if (reference) {
          return;
        }
        yield* removeFiles(id);
        yield* tx
          .update(sets)
          .set({
            downloadState: "none",
            retainedAudioBytes: null,
            retainedAudioFormat: null,
            tracklistRunId: null,
            tracklistRunStartedAt: null,
            tracklistState: "pending",
          })
          .where(eq(sets.id, id));
        yield* tx.delete(downloadJobs).where(eq(downloadJobs.setId, id));
        yield* tx.delete(setCues).where(eq(setCues.setId, id));
      })
    );
  }).pipe(Effect.mapError(releaseError));
