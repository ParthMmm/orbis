import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Exit, Layer } from "effect";

import { Cobalt } from "./cobalt.js";
import { DownloadBackends } from "./download-backends.js";
import type { BackendName } from "./download-backends.js";
import { configureLogging, loggingLayer, withWideEvent } from "./logging.js";
import { MediaStore } from "./media-store.js";
import { Ytdlp } from "./ytdlp.js";

/**
 * A nightly check that each download backend still fetches whole, readable audio,
 * through the worker's own code, before a user's download finds out it does not.
 * Run by orbis-canary.timer. It records one `download-canary` wide event, writes
 * `canary/last.json` and appends `canary/history.jsonl` under ORBIS_DATA_DIR, and
 * exits 1 when a check fails so the unit shows as failed.
 */

interface Fixture {
  readonly durationSeconds: number;
  readonly name: string;
  readonly url: string;
}

// A short and a long Set per source: Cobalt failed only on long YouTube audio.
const FIXTURES: readonly Fixture[] = [
  {
    durationSeconds: 597,
    name: "youtube-short",
    url: "https://www.youtube.com/watch?v=YE7VzlLtp-4",
  },
  {
    durationSeconds: 7173,
    name: "youtube-long",
    url: "https://www.youtube.com/watch?v=x8r5otKq75w",
  },
  {
    durationSeconds: 6902,
    name: "soundcloud-long",
    url: "https://soundcloud.com/rinsefm/skin-on-skin-07-august-2026",
  },
];

// Long Ogg files measured up to 9% short of the source; see docs/research/cobalt-audio-format.md.
const DURATION_TOLERANCE = 0.1;

interface CheckResult {
  readonly backend: BackendName;
  readonly bytes: number | null;
  readonly durationSeconds: number | null;
  readonly elapsedMs: number;
  readonly fixture: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

const ignoreProgress = () => {
  // The canary reads the stored result, not progress.
};

const check = Effect.fn("Canary.check")(function* check(
  backend: BackendName,
  fixture: Fixture
) {
  const backends = yield* DownloadBackends;
  const media = yield* MediaStore;
  const id = `${fixture.name}-${backend}`;
  const tmpPath = media.partialPath(id);
  const { signal } = new AbortController();
  const started = Date.now();
  const result: CheckResult = yield* backends
    .fetch(backend, fixture.url, tmpPath, ignoreProgress, signal)
    .pipe(
      Effect.andThen(media.storeDownloaded(id, tmpPath)),
      Effect.match({
        onFailure: (error) => ({
          backend,
          bytes: null,
          durationSeconds: null,
          elapsedMs: Date.now() - started,
          fixture: fixture.name,
          ok: false,
          reason: error.message,
        }),
        onSuccess: (stored) => {
          const seconds = Math.round(stored.durationSeconds);
          const ok =
            Math.abs(stored.durationSeconds - fixture.durationSeconds) <=
            fixture.durationSeconds * DURATION_TOLERANCE;
          return {
            backend,
            bytes: stored.bytes,
            durationSeconds: seconds,
            elapsedMs: Date.now() - started,
            fixture: fixture.name,
            ok,
            reason: ok
              ? null
              : `Stored ${seconds}s, expected ${fixture.durationSeconds}s.`,
          };
        },
      })
    );
  yield* (result.ok ? Effect.logInfo : Effect.logWarning)("canary check").pipe(
    Effect.annotateLogs({ ...result })
  );
  return result;
});

const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
const canaryDirectory = path.join(dataDirectory, "canary");
await mkdir(canaryDirectory, { recursive: true });
const workDirectory = await mkdtemp(path.join(canaryDirectory, "run-"));
configureLogging({ environment: process.env.NODE_ENV ?? "development" });
const options = {
  audioDir: workDirectory,
  cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
  cobaltUrl: process.env.ORBIS_COBALT_URL,
  ytdlpBin: process.env.ORBIS_YTDLP_BIN,
  ytdlpCookies: process.env.ORBIS_YTDLP_COOKIES,
};

const program = Effect.gen(function* runCanary() {
  const downloads = yield* DownloadBackends;
  // Each backend is checked on every fixture, not only where it comes first.
  const backends = downloads.forSource("youtube");
  const results = yield* Effect.forEach(
    FIXTURES.flatMap((fixture) =>
      backends.map((backend) => ({ backend, fixture }))
    ),
    ({ backend, fixture }) => check(backend, fixture)
  );
  const failed = results.filter((result) => !result.ok).length;
  const record = {
    at: new Date().toISOString(),
    backends,
    ok: results.length > 0 && failed === 0,
    results,
  };
  yield* Effect.promise(async () => {
    await writeFile(
      path.join(canaryDirectory, "last.json"),
      `${JSON.stringify(record, null, 2)}\n`
    );
    await appendFile(
      path.join(canaryDirectory, "history.jsonl"),
      `${JSON.stringify(record)}\n`
    );
  });
  if (!record.ok) {
    return yield* Effect.fail(
      new Error(
        results.length === 0
          ? "No download backend is configured."
          : `${failed} of ${results.length} canary checks failed.`
      )
    );
  }
}).pipe(withWideEvent({ job: "download-canary" }));

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.provide(
      DownloadBackends.layer.pipe(
        Layer.provideMerge(MediaStore.layer(options)),
        Layer.provide(Cobalt.layer(options)),
        Layer.provide(Ytdlp.layer(options))
      )
    ),
    Effect.provide(loggingLayer)
  )
);
await rm(workDirectory, { force: true, recursive: true });
process.exit(Exit.isSuccess(exit) ? 0 : 1);
