import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Database } from "./db/database.js";
import { listens } from "./db/schema.js";
import { LibraryError } from "./errors.js";
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
      const db = yield* Database;
      const personId = yield* LibraryPerson;
      const recordListen = Effect.fn("Stats.recordListen")((setId: string) =>
        execute(
          db.insert(listens).values({
            personId,
            setId,
            startedAt: new Date().toISOString(),
          })
        ).pipe(Effect.asVoid)
      );
      const recordFinish = Effect.fn("Stats.recordFinish")((setId: string) =>
        execute(
          Effect.gen(function* finishLatestListen() {
            const [latest] = yield* db
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
              yield* db
                .update(listens)
                .set({ finishedAt: new Date().toISOString() })
                .where(
                  and(eq(listens.id, latest.id), isNull(listens.finishedAt))
                );
            }
          })
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
