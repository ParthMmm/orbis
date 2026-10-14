import path from "node:path";

import { ne } from "drizzle-orm";
import { Duration, Effect, Layer, Result } from "effect";

import { Database, layer as databaseLayer } from "./db/database.js";
import { sets } from "./db/schema.js";
import { Library } from "./library.js";
import { Metadata } from "./metadata.js";
import { ytDlpMetadata } from "./ytdlp-metadata.js";

export interface BackfillDetailsOptions {
  readonly delayMillis: number;
}

export const backfillDetails = Effect.fn("backfillDetails")(
  function* backfillDetailsEffect(options: BackfillDetailsOptions) {
    const db = yield* Database;
    const library = yield* Library;
    const metadata = yield* Metadata;

    const rows = yield* db
      .select({ id: sets.id, source: sets.source, url: sets.url })
      .from(sets)
      .where(ne(sets.detailsState, "filled"));

    const results: Result.Result<void, unknown>[] = [];
    for (const [index, row] of rows.entries()) {
      if (index > 0 && options.delayMillis > 0) {
        yield* Effect.sleep(Duration.millis(options.delayMillis));
      }
      const result = yield* metadata
        .details({ source: row.source, url: row.url })
        .pipe(
          Effect.flatMap((details) => library.recordDetails(row.id, details)),
          Effect.tap(() =>
            Effect.log(`${index + 1} of ${rows.length}: filled ${row.id}`)
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `${index + 1} of ${rows.length}: kept ${row.id} as it was: ${error.message}`
            )
          ),
          Effect.result
        );
      results.push(result);
    }

    return {
      attempted: rows.length,
      filled: results.filter((result) => Result.isSuccess(result)).length,
    };
  }
);

const DEFAULT_DELAY_MILLIS = 1000;

const main = async () => {
  const binPath = process.env.ORBIS_YTDLP_BIN;
  if (!binPath || !path.isAbsolute(binPath)) {
    console.error(
      "ORBIS_YTDLP_BIN must be set to the absolute path of the yt-dlp binary."
    );
    return 1;
  }
  const delay = Number(
    process.env.ORBIS_BACKFILL_DELAY_MS ?? DEFAULT_DELAY_MILLIS
  );
  if (!Number.isFinite(delay) || delay < 0) {
    console.error(
      "ORBIS_BACKFILL_DELAY_MS must be a number of milliseconds, 0 or more."
    );
    return 1;
  }

  const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
  const database = databaseLayer({
    databasePath: path.join(dataDirectory, "library.sqlite"),
    migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
  });
  const layers = Layer.mergeAll(
    Library.layer,
    Metadata.layer({ ytDlp: ytDlpMetadata({ binPath }) })
  ).pipe(Layer.provideMerge(database));

  return await Effect.runPromise(
    backfillDetails({ delayMillis: delay }).pipe(
      Effect.tap(({ attempted, filled }) =>
        Effect.log(`${filled} of ${attempted} Sets now hold their details.`)
      ),
      Effect.map(({ attempted, filled }) => (filled === attempted ? 0 : 1)),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(`The backfill stopped: ${String(error)}`);
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
