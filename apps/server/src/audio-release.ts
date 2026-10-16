import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { downloadJobs, setCues, sets } from "./db/schema.js";
import { Database } from "./db/service.js";
import { asLibraryError } from "./errors.js";
import type { LibraryError } from "./errors.js";

export const releaseAudio = Effect.fn("AudioRelease.release")(
  function* releaseStoredAudio(
    id: string,
    removeFiles: (id: string) => Effect.Effect<void, LibraryError> = () =>
      Effect.void,
    afterRelease: (id: string) => Effect.Effect<void, LibraryError> = () =>
      Effect.void
  ) {
    const db = yield* Database;
    const released = yield* db.transaction((tx) =>
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
        return true;
      })
    );
    if (released) {
      yield* removeFiles(id);
      yield* afterRelease(id);
    }
  },
  asLibraryError("Could not release audio.")
);
