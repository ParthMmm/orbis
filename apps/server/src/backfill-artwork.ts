import path from "node:path";

import { Effect } from "effect";

import { backfillArtwork } from "./artwork.js";
import { layer as databaseLayer } from "./db/database.js";
import { Metadata } from "./metadata.js";

/**
 * Runs the artwork backfill against the library on this host.
 *
 * Usage: ORBIS_YOUTUBE_API_KEY=<key> bun run backfill:artwork
 *
 * Exits non-zero when a Set could not be filled; a second run picks up those Sets.
 */
const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
const databasePath = path.join(dataDirectory, "library.sqlite");
const youTubeApiKey = process.env.ORBIS_YOUTUBE_API_KEY;

if (!youTubeApiKey) {
  console.warn(
    "ORBIS_YOUTUBE_API_KEY is not set, so YouTube Sets keep the image they have."
  );
}

process.exitCode = await Effect.runPromise(
  backfillArtwork.pipe(
    Effect.tap(({ attempted, filled }) =>
      Effect.log(`${filled} of ${attempted} Sets now hold both images.`)
    ),
    Effect.map(({ attempted, filled }) => (filled === attempted ? 0 : 1)),
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`The backfill stopped: ${String(error)}`);
        return 1;
      })
    ),
    Effect.provide(Metadata.layer({ youTubeApiKey })),
    Effect.provide(
      databaseLayer({
        databasePath,
        migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
      })
    )
  )
);
