import type { Cue, Tracklist } from "@orbis/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { Duration, Effect } from "effect";

import { Database } from "./db/database.js";
import {
  libraryEntries,
  playlistSets,
  queueEntries,
  setCues,
  sets,
} from "./db/schema.js";
import { LibraryError } from "./errors.js";
import { Versos } from "./versos.js";

const POLL_DELAYS_MS = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000];

const hasReference = (db: typeof Database.Service, id: string) =>
  db.get<{ readonly present: number }>(sql`
    SELECT 1 AS present FROM ${libraryEntries} WHERE ${libraryEntries.setId} = ${id}
    UNION ALL SELECT 1 AS present FROM ${playlistSets} WHERE ${playlistSets.setId} = ${id}
    UNION ALL SELECT 1 AS present FROM ${queueEntries} WHERE ${queueEntries.setId} = ${id}
    LIMIT 1
  `);

export const readTracklist = Effect.fn("Tracklists.read")((id: string) =>
  Effect.gen(function* readTracklistEffect() {
    const db = yield* Database;
    const [set] = yield* db
      .select({ state: sets.tracklistState })
      .from(sets)
      .where(eq(sets.id, id));
    if (!set) {
      return yield* Effect.fail(
        new LibraryError({ message: "Set not found.", statusCode: 404 })
      );
    }
    const cues = yield* db
      .select({
        appleMusicId: setCues.appleMusicId,
        artist: setCues.artist,
        artworkUrl: setCues.artworkUrl,
        position: setCues.position,
        startSeconds: setCues.startSeconds,
        title: setCues.title,
      })
      .from(setCues)
      .where(eq(setCues.setId, id))
      .orderBy(asc(setCues.position));
    return { cues, state: set.state } satisfies Tracklist;
  })
);

const replaceTracklist = (
  id: string,
  result: { state: "none" } | { state: "ready"; cues: readonly Cue[] }
) =>
  Effect.gen(function* replaceTracklistEffect() {
    const db = yield* Database;
    return yield* db.transaction((tx) =>
      Effect.gen(function* replace() {
        const [set] = yield* tx.select().from(sets).where(eq(sets.id, id));
        if (!set || !(yield* hasReference(tx, id))) {
          return false;
        }
        yield* tx.delete(setCues).where(eq(setCues.setId, id));
        if (result.state === "ready" && result.cues.length > 0) {
          yield* tx
            .insert(setCues)
            .values(result.cues.map((cue) => ({ ...cue, setId: id })));
        }
        yield* tx
          .update(sets)
          .set({ tracklistState: result.state })
          .where(eq(sets.id, id));
        return true;
      })
    );
  });

const failTracklist = (id: string) =>
  Effect.gen(function* failTracklistEffect() {
    const db = yield* Database;
    return yield* db.transaction((tx) =>
      Effect.gen(function* markFailure() {
        if (!(yield* hasReference(tx, id))) {
          return;
        }
        yield* tx
          .update(sets)
          .set({ tracklistState: "failed" })
          .where(eq(sets.id, id));
      })
    );
  });

export const runTracklist = Effect.fn("Tracklists.run")((id: string) =>
  Effect.gen(function* runTracklistEffect() {
    const db = yield* Database;
    const versos = yield* Versos;
    const [set] = yield* db
      .select({
        description: sets.description,
        source: sets.source,
        url: sets.url,
      })
      .from(sets)
      .where(eq(sets.id, id));
    if (!set || !(yield* hasReference(db, id))) {
      return "pending" as const;
    }
    if (!set.description?.trim()) {
      yield* replaceTracklist(id, { state: "none" });
      return "none" as const;
    }
    const requested = yield* Effect.result(
      versos.request({
        description: set.description,
        source: set.source,
        url: set.url,
      })
    );
    if (requested._tag === "Failure") {
      if (requested.failure.reason === "not-configured") {
        return "pending" as const;
      }
      yield* failTracklist(id);
      yield* Effect.logWarning("set Tracklist request failed").pipe(
        Effect.annotateLogs({ reason: requested.failure.reason, set: id })
      );
      return "failed" as const;
    }
    for (const delay of POLL_DELAYS_MS) {
      const answer = yield* Effect.result(
        versos.poll(requested.success.requestId)
      );
      if (answer._tag === "Failure") {
        yield* failTracklist(id);
        yield* Effect.logWarning("set Tracklist poll failed").pipe(
          Effect.annotateLogs({ reason: answer.failure.reason, set: id })
        );
        return "failed" as const;
      }
      if (answer.success.state !== "pending") {
        yield* replaceTracklist(id, answer.success);
        return answer.success.state;
      }
      yield* Effect.sleep(Duration.millis(delay));
    }
    yield* failTracklist(id);
    yield* Effect.logWarning("set Tracklist poll timed out").pipe(
      Effect.annotateLogs({ set: id })
    );
    return "failed" as const;
  })
);
