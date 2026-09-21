import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Database } from "./db/database.js";
import { sets } from "./db/schema.js";
import { LibraryError } from "./errors.js";

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the library request.",
    statusCode: 500,
  });

const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();

const execute = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.mapError(toLibraryError));

/**
 * The two counters a Listen produces, kept as totals rather than as events.
 *
 * Nothing here decides whether a Listen happened. The Listening Queue owns that: the entry it
 * marks active is the Set with a Listen open, so a Set that is already active is never counted
 * twice however many times a client repeats a signal.
 */
export class Stats extends Context.Service<
  Stats,
  {
    readonly recordListen: (id: string) => Effect.Effect<void, LibraryError>;
    readonly recordFinish: (id: string) => Effect.Effect<void, LibraryError>;
  }
>()("@orbis/Stats") {
  static readonly layer = Layer.effect(
    Stats,
    Effect.gen(function* buildStats() {
      const db = yield* Database;
      // A Listen opens when a Set becomes the active one. The date moves with it, so the Set
      // details can say when it was last heard without a second read.
      const recordListen = Effect.fn("Stats.recordListen")((id: string) =>
        execute(
          db
            .update(sets)
            .set({
              lastListenedAt: new Date().toISOString(),
              listenCount: sql<number>`${sets.listenCount} + 1`,
            })
            .where(eq(sets.id, id))
        ).pipe(Effect.asVoid)
      );
      // One Listen finishes at most once, because the caller counts a Finish only for the Set it
      // is finishing while that Set is still the active one.
      const recordFinish = Effect.fn("Stats.recordFinish")((id: string) =>
        execute(
          db
            .update(sets)
            .set({ finishCount: sql<number>`${sets.finishCount} + 1` })
            .where(eq(sets.id, id))
        ).pipe(Effect.asVoid)
      );
      return { recordFinish, recordListen };
    })
  );
}
