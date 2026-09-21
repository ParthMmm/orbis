import { rm } from "node:fs/promises";

import type { SavedSet } from "@orbis/contracts";
import { Context, Effect, Layer, Queue, Stream } from "effect";

import { Cobalt } from "./cobalt.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
import { MediaStore } from "./media-store.js";

export interface DownloadWorkerOptions {
  readonly startWorker?: boolean;
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

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
  ): Layer.Layer<DownloadWorker, never, Library | Cobalt | MediaStore> {
    return Layer.effect(
      DownloadWorker,
      Effect.gen(function* buildWorker() {
        const library = yield* Library;
        const cobalt = yield* Cobalt;
        const media = yield* MediaStore;
        const wakeQueue = yield* Queue.unbounded<undefined>();
        const progress = new Map<string, DownloadProgress>();
        const aborts = new Map<string, AbortController>();
        const requeued = yield* library
          .resetStuckDownloads()
          .pipe(Effect.orDie);
        yield* Effect.logInfo("download worker started").pipe(
          Effect.annotateLogs({
            configured: cobalt.isConfigured,
            requeued,
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
                const tunnelUrl = yield* cobalt.requestTunnel(
                  set.url,
                  abort.signal
                );
                const response = yield* cobalt.openTunnel(
                  tunnelUrl,
                  abort.signal
                );
                yield* media.streamResponse(
                  response,
                  tmpPath,
                  (received, total) => {
                    progress.set(set.id, { received, total });
                  },
                  abort.signal
                );
                const stored = yield* media.storeDownloaded(set.id, tmpPath);
                const finished = yield* library.finishDownload(set.id, stored);
                yield* Effect.logInfo("audio download finished").pipe(
                  Effect.annotateLogs({
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
            yield* Effect.matchEffect(downloadOne(claimed), {
              onFailure: (error) =>
                library.failDownload(claimed.id).pipe(
                  Effect.andThen(
                    Effect.logWarning("audio download failed").pipe(
                      Effect.annotateLogs({
                        reason:
                          error instanceof LibraryError
                            ? error.message
                            : "unknown",
                        set: claimed.id,
                      })
                    )
                  )
                ),
              onSuccess: () => Effect.void,
            });
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
          Queue.offer(wakeQueue, undefined)
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
