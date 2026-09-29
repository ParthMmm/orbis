import { rm } from "node:fs/promises";

import type { SavedSet } from "@orbis/contracts";
import { Cause, Context, Effect, Exit, Layer, Queue, Stream } from "effect";

import { DownloadBackends } from "./download-backends.js";
import type { BackendName } from "./download-backends.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
import { withWideEvent } from "./logging.js";
import type { LoggingOptions } from "./logging.js";
import { MediaStore } from "./media-store.js";

export interface DownloadWorkerOptions {
  readonly logging?: LoggingOptions | undefined;
  readonly startWorker?: boolean;
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

// A backend failure is retryable on the next backend. A cancel is terminal.
const fetchWithFallback = (
  names: readonly BackendName[],
  fetchWith: (backend: BackendName) => Effect.Effect<void, LibraryError>,
  tmpPath: string,
  signal: AbortSignal
): Effect.Effect<BackendName, LibraryError> => {
  const [current, ...rest] = names;
  if (!current) {
    return Effect.fail(
      new LibraryError({
        message: "No download backend is configured.",
        statusCode: 500,
      })
    );
  }
  return fetchWith(current).pipe(
    Effect.as(current),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logWarning("audio backend failed").pipe(
          Effect.annotateLogs({
            backend: current,
            bytes: Bun.file(tmpPath).size,
            reason: error.message,
          }),
          Effect.andThen(
            rest.length === 0 || signal.aborted
              ? Effect.fail(error)
              : Effect.promise(() => rm(tmpPath, { force: true })).pipe(
                  Effect.andThen(
                    fetchWithFallback(rest, fetchWith, tmpPath, signal)
                  )
                )
          )
        ),
      onSuccess: (name) => Effect.succeed(name),
    })
  );
};

export class DownloadWorker extends Context.Service<
  DownloadWorker,
  {
    readonly wake: () => Effect.Effect<void>;
    readonly processNext: () => Effect.Effect<boolean, never>;
    readonly progressFor: (id: string) => DownloadProgress | undefined;
    readonly abort: (id: string) => void;
  }
>()("@orbis/DownloadWorker") {
  static layer(
    options: DownloadWorkerOptions = {}
  ): Layer.Layer<
    DownloadWorker,
    never,
    DownloadBackends | Library | MediaStore
  > {
    return Layer.effect(
      DownloadWorker,
      Effect.gen(function* buildWorker() {
        const backends = yield* DownloadBackends;
        const library = yield* Library;
        const media = yield* MediaStore;
        const wakeQueue = yield* Queue.unbounded<true>();
        const progress = new Map<string, DownloadProgress>();
        const aborts = new Map<string, AbortController>();
        const requeued = yield* library
          .resetStuckDownloads()
          .pipe(Effect.orDie);
        yield* Effect.logInfo("download worker started").pipe(
          Effect.annotateLogs({
            requeued,
            soundcloud: backends.forSource("soundcloud").join(","),
            youtube: backends.forSource("youtube").join(","),
          })
        );
        const downloadOne = Effect.fn("DownloadWorker.downloadOne")(
          function* downloadOne(set: SavedSet) {
            const tmpPath = media.partialPath(set.id);
            const abort = new AbortController();
            aborts.set(set.id, abort);
            progress.set(set.id, { received: 0, total: null });
            yield* Effect.ensuring(
              Effect.gen(function* runDownload() {
                const onProgress = (received: number, total: number | null) => {
                  progress.set(set.id, { received, total });
                };
                const backend = yield* fetchWithFallback(
                  backends.forSource(set.source),
                  (name) =>
                    backends.fetch(
                      name,
                      set.url,
                      tmpPath,
                      onProgress,
                      abort.signal
                    ),
                  tmpPath,
                  abort.signal
                );
                const stored = yield* media.storeDownloaded(set.id, tmpPath);
                const finished = yield* library.finishDownload(set.id, stored);
                yield* library.release(set.id);
                yield* Effect.logInfo("audio download finished").pipe(
                  Effect.annotateLogs({
                    backend,
                    bytes: finished.retainedAudioBytes ?? 0,
                    durationSeconds: finished.durationSeconds ?? 0,
                    format: stored.format,
                    set: set.id,
                  })
                );
                return finished;
              }),
              Effect.gen(function* cleanupDownload() {
                yield* Effect.ignore(
                  Effect.promise(() => rm(tmpPath, { force: true }))
                );
              })
            );
          }
        );
        const processNext = Effect.fn("DownloadWorker.processNext")(() =>
          Effect.gen(function* pollOnce() {
            const claimed = yield* Effect.matchEffect(library.claimDownload(), {
              onFailure: (error) =>
                Effect.logWarning("audio worker claim failed").pipe(
                  Effect.annotateLogs({
                    reason:
                      error instanceof LibraryError ? error.message : "unknown",
                  }),
                  Effect.andThen(Effect.succeed(null))
                ),
              onSuccess: (current) => Effect.succeed(current),
            });
            if (!claimed) {
              return false;
            }
            yield* Effect.logInfo("audio download claimed").pipe(
              Effect.annotateLogs({ set: claimed.id, source: claimed.source })
            );
            const outcome = yield* Effect.exit(
              downloadOne(claimed).pipe(
                withWideEvent(
                  {
                    job: "audio-download",
                    set: claimed.id,
                    source: claimed.source,
                  },
                  options.logging
                )
              )
            );
            if (Exit.isFailure(outcome)) {
              if (Cause.hasInterruptsOnly(outcome.cause)) {
                return yield* Effect.interrupt;
              }
              const reason = Cause.squash(outcome.cause);
              yield* library.failDownload(claimed.id);
              yield* Effect.logWarning("audio download failed").pipe(
                Effect.annotateLogs({
                  reason: reason instanceof Error ? reason.message : "unknown",
                  set: claimed.id,
                })
              );
            }
            aborts.delete(claimed.id);
            progress.delete(claimed.id);
            return true;
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logWarning("audio worker round failed").pipe(
                  Effect.annotateLogs({
                    reason:
                      error instanceof LibraryError ? error.message : "unknown",
                  }),
                  Effect.andThen(Effect.succeed(false))
                ),
              onSuccess: (worked) => Effect.succeed(worked),
            })
          )
        );
        const drain = Effect.fn("DownloadWorker.drain")(function* drain() {
          while (yield* processNext()) {
            // SQLite is authoritative; keep claiming until the queue is empty.
          }
        });
        const wake = Effect.fn("DownloadWorker.wake")(() =>
          Queue.offer(wakeQueue, true)
        );
        if (options.startWorker === true) {
          yield* wake();
          yield* Effect.forkScoped(
            Stream.fromQueue(wakeQueue).pipe(Stream.runForEach(() => drain()))
          );
        }
        const abort = (id: string) => {
          aborts.get(id)?.abort();
          aborts.delete(id);
          progress.delete(id);
        };
        const progressFor = (id: string) => progress.get(id);
        return {
          abort,
          processNext,
          progressFor,
          wake,
        };
      })
    );
  }
}
