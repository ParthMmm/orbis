import type { Cue, Tracklist } from "@orbis/contracts";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
const RUN_LEASE_MS = 5 * 60_000;

interface TracklistClaim {
  readonly description: string | null;
  readonly id: string;
  readonly source: (typeof sets.$inferSelect)["source"];
  readonly token: string;
  readonly url: string;
}

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

export const claimTracklist = Effect.fn("Tracklists.claim")(
  (id: string, retry = false) =>
    Effect.gen(function* claimTracklistEffect() {
      const db = yield* Database;
      const token = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const expiredAt = new Date(Date.now() - RUN_LEASE_MS).toISOString();
      const [claimed] = yield* db
        .update(sets)
        .set({
          tracklistRunId: token,
          tracklistRunStartedAt: startedAt,
          tracklistState: "pending",
        })
        .where(
          and(
            eq(sets.id, id),
            retry
              ? undefined
              : inArray(sets.tracklistState, ["pending", "failed"]),
            or(
              isNull(sets.tracklistRunId),
              lt(sets.tracklistRunStartedAt, expiredAt)
            ),
            sql`EXISTS (
            SELECT 1 FROM ${libraryEntries} WHERE ${libraryEntries.setId} = ${sets.id}
            UNION ALL SELECT 1 FROM ${playlistSets} WHERE ${playlistSets.setId} = ${sets.id}
            UNION ALL SELECT 1 FROM ${queueEntries} WHERE ${queueEntries.setId} = ${sets.id}
          )`
          )
        )
        .returning({
          description: sets.description,
          id: sets.id,
          source: sets.source,
          url: sets.url,
        });
      return claimed ? ({ ...claimed, token } satisfies TracklistClaim) : null;
    })
);

const finishTracklist = (
  claim: TracklistClaim,
  result: { state: "none" } | { state: "ready"; cues: readonly Cue[] }
) =>
  Effect.gen(function* finishTracklistEffect() {
    const db = yield* Database;
    return yield* db.transaction((tx) =>
      Effect.gen(function* finish() {
        const [owned] = yield* tx
          .update(sets)
          .set({
            tracklistRunId: null,
            tracklistRunStartedAt: null,
            tracklistState: result.state,
          })
          .where(
            and(eq(sets.id, claim.id), eq(sets.tracklistRunId, claim.token))
          )
          .returning({ id: sets.id });
        if (!owned) {
          return false;
        }
        if (!(yield* hasReference(tx, claim.id))) {
          yield* tx
            .update(sets)
            .set({ tracklistState: "pending" })
            .where(eq(sets.id, claim.id));
          yield* tx.delete(setCues).where(eq(setCues.setId, claim.id));
          return false;
        }
        yield* tx.delete(setCues).where(eq(setCues.setId, claim.id));
        if (result.state === "ready" && result.cues.length > 0) {
          yield* tx
            .insert(setCues)
            .values(result.cues.map((cue) => ({ ...cue, setId: claim.id })));
        }
        return true;
      })
    );
  });

const releaseClaim = (claim: TracklistClaim, state: "pending" | "failed") =>
  Effect.gen(function* releaseTracklistClaim() {
    const db = yield* Database;
    yield* db
      .update(sets)
      .set({
        tracklistRunId: null,
        tracklistRunStartedAt: null,
        tracklistState: state,
      })
      .where(and(eq(sets.id, claim.id), eq(sets.tracklistRunId, claim.token)));
  });

export const runClaimedTracklist = Effect.fn("Tracklists.runClaimed")(
  (claim: TracklistClaim) =>
    Effect.gen(function* runClaimedTracklistEffect() {
      const versos = yield* Versos;
      if (!claim.description?.trim()) {
        return (yield* finishTracklist(claim, { state: "none" }))
          ? "none"
          : "pending";
      }
      const requested = yield* Effect.result(
        versos.request({
          description: claim.description,
          source: claim.source,
          url: claim.url,
        })
      );
      if (requested._tag === "Failure") {
        if (requested.failure.reason === "not-configured") {
          yield* releaseClaim(claim, "pending");
          return "pending" as const;
        }
        yield* releaseClaim(claim, "failed");
        yield* Effect.logWarning("set Tracklist request failed").pipe(
          Effect.annotateLogs({
            reason: requested.failure.reason,
            set: claim.id,
          })
        );
        return "failed" as const;
      }
      for (const delay of POLL_DELAYS_MS) {
        const answer = yield* Effect.result(
          versos.poll(requested.success.requestId)
        );
        if (answer._tag === "Failure") {
          yield* releaseClaim(claim, "failed");
          yield* Effect.logWarning("set Tracklist poll failed").pipe(
            Effect.annotateLogs({
              reason: answer.failure.reason,
              set: claim.id,
            })
          );
          return "failed" as const;
        }
        if (answer.success.state !== "pending") {
          return (yield* finishTracklist(claim, answer.success))
            ? answer.success.state
            : "pending";
        }
        yield* Effect.sleep(Duration.millis(delay));
      }
      yield* releaseClaim(claim, "failed");
      yield* Effect.logWarning("set Tracklist poll timed out").pipe(
        Effect.annotateLogs({ set: claim.id })
      );
      return "failed" as const;
    }).pipe(Effect.onInterrupt(() => releaseClaim(claim, "pending")))
);

export const runTracklist = Effect.fn("Tracklists.run")((id: string) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* runTracklistEffect() {
      const claim = yield* claimTracklist(id);
      return claim ? yield* restore(runClaimedTracklist(claim)) : "pending";
    })
  )
);
