import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { Duration, Effect, Layer } from "effect";

import { Database, layer as databaseLayer } from "./db/database.js";
import { sets } from "./db/schema.js";
import { runTracklist } from "./tracklists.js";
import { Versos } from "./versos.js";

export interface BackfillTracklistsOptions {
  readonly delayMillis: number;
}

export const backfillTracklists = Effect.fn("backfillTracklists")(
  function* backfillTracklistsEffect(options: BackfillTracklistsOptions) {
    const db = yield* Database;
    const rows = yield* db
      .select({ id: sets.id })
      .from(sets)
      .where(
        and(
          eq(sets.detailsState, "filled"),
          inArray(sets.tracklistState, ["pending", "failed"])
        )
      );
    let completed = 0;
    for (const [index, row] of rows.entries()) {
      if (index > 0 && options.delayMillis > 0) {
        yield* Effect.sleep(Duration.millis(options.delayMillis));
      }
      const state = yield* runTracklist(row.id);
      if (state === "ready" || state === "none") {
        completed += 1;
      }
      yield* Effect.log(`${index + 1} of ${rows.length}: ${state} ${row.id}`);
    }
    return { attempted: rows.length, completed };
  }
);

const main = async () => {
  const delayMillis = Number(process.env.ORBIS_BACKFILL_DELAY_MS ?? 1000);
  if (!Number.isFinite(delayMillis) || delayMillis < 0) {
    console.error("ORBIS_BACKFILL_DELAY_MS must be 0 or more milliseconds.");
    return 1;
  }
  const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
  const database = databaseLayer({
    databasePath: path.join(dataDirectory, "library.sqlite"),
    migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
  });
  const layers = Layer.mergeAll(database, Versos.layerConfig());
  return await Effect.runPromise(
    backfillTracklists({ delayMillis }).pipe(
      Effect.tap(({ attempted, completed }) =>
        Effect.log(
          `${completed} of ${attempted} Sets have a resolved Tracklist state.`
        )
      ),
      Effect.map(({ attempted, completed }) =>
        completed === attempted ? 0 : 1
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(`The Tracklist backfill stopped: ${String(error)}`);
          return 1;
        })
      ),
      Effect.provide(layers)
    )
  );
};

if (import.meta.main) {
  process.exitCode = await main();
}
