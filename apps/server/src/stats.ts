import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { listens } from "./db/schema.js";
import { LibraryError } from "./errors.js";
import { Journal } from "./journal.js";
import { LibraryPerson } from "./library-person.js";

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the library request.",
    statusCode: 500,
  });

const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();

const execute = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.mapError(toLibraryError));

export class Stats extends Context.Service<
  Stats,
  {
    readonly recordListen: (id: string) => Effect.Effect<void, LibraryError>;
    readonly recordFinish: (id: string) => Effect.Effect<void, LibraryError>;
  }
>()("@orbis/Stats") {
  static readonly scopedLayer = Layer.effect(
    Stats,
    Effect.gen(function* buildStats() {
      const journal = yield* Journal;
      const personId = yield* LibraryPerson;
      const recordListen = Effect.fn("Stats.recordListen")((setId: string) =>
        execute(
          journal.transaction((tx) =>
            Effect.gen(function* startListen() {
              yield* tx.insert(listens).values({
                personId,
                setId,
                startedAt: new Date().toISOString(),
              });
              yield* journal.record(tx, { personId, topic: "listen-history" });
            })
          )
        )
      );
      const recordFinish = Effect.fn("Stats.recordFinish")((setId: string) =>
        execute(
          journal.transaction((tx) =>
            Effect.gen(function* finishLatestListen() {
              const [latest] = yield* tx
                .select({ id: listens.id })
                .from(listens)
                .where(
                  and(
                    eq(listens.personId, personId),
                    eq(listens.setId, setId),
                    isNull(listens.finishedAt)
                  )
                )
                .orderBy(desc(listens.id))
                .limit(1);
              if (latest) {
                yield* tx
                  .update(listens)
                  .set({ finishedAt: new Date().toISOString() })
                  .where(
                    and(eq(listens.id, latest.id), isNull(listens.finishedAt))
                  );
                yield* journal.record(tx, {
                  personId,
                  topic: "listen-history",
                });
              }
            })
          )
        )
      );
      return { recordFinish, recordListen };
    })
  );

  static forPersonLayer(personId: string) {
    return Layer.fresh(Stats.scopedLayer).pipe(
      Layer.provide(Layer.succeed(LibraryPerson, personId))
    );
  }
}
