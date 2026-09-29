import { rm } from "node:fs/promises";

import type { SavedSet } from "@orbis/contracts";
import { Cause, Context, Effect, Exit, Layer, Queue, Stream } from "effect";

import { Cobalt } from "./cobalt.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
import { MediaStore } from "./media-store.js";
import { Ytdlp } from "./ytdlp.js";

export interface DownloadWorkerOptions {
  readonly startWorker?: boolean;
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

export type BackendName = "cobalt" | "ytdlp";

interface Backend {
  readonly name: BackendName;
  readonly run: Effect.Effect<void, LibraryError>;
}

// Each source goes first to the backend proven on it; the other is the safety net.
export const backendOrder = (source: SavedSet["source"]) =>
  source === "youtube"
    ? (["ytdlp", "cobalt"] as const)
    : (["cobalt", "ytdlp"] as const);

// A backend failure is retryable on the next backend. A cancel is terminal.
const fetchWithFallback = (
  backends: readonly Backend[],
  setId: string,
  tmpPath: string,
  signal: AbortSignal
): Effect.Effect<BackendName, LibraryError> => {
  const [current, ...rest] = backends;
  if (!current) {
    return Effect.fail(
      new LibraryError({
        message: "No download backend is configured.",
        statusCode: 500,
      })
    );
  }
  return current.run.pipe(
    Effect.as(current.name),
    Effect.matchEffect({
      onFailure: (error) =>
        rest.length === 0 || signal.aborted
          ? Effect.fail(error)
          : Effect.logWarning("audio backend failed, trying the next").pipe(
              Effect.annotateLogs({
                backend: current.name,
                reason: error.message,
                set: setId,
              }),
              Effect.andThen(
                Effect.promise(() => rm(tmpPath, { force: true }))
              ),
              Effect.andThen(fetchWithFallback(rest, setId, tmpPath, signal))
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
  ): Layer.Layer<DownloadWorker, never, Library | Cobalt | MediaStore | Ytdlp> {
    return Layer.effect(
      DownloadWorker,
      Effect.gen(function* buildWorker() {
        const library = yield* Library;
        const cobalt = yield* Cobalt;
        const media = yield* MediaStore;
        const ytdlp = yield* Ytdlp;
        const wakeQueue = yield* Queue.unbounded<true>();
        const progress = new Map<string, DownloadProgress>();
        const aborts = new Map<string, AbortController>();
        const requeued = yield* library
          .resetStuckDownloads()
          .pipe(Effect.orDie);
        yield* Effect.logInfo("download worker started").pipe(
          Effect.annotateLogs({
            cobalt: cobalt.isConfigured,
            requeued,
            ytdlp: ytdlp.isConfigured,
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
                const fetchCobalt = Effect.gen(function* viaCobalt() {
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
                    onProgress,
                    abort.signal
                  );
                });
                const backends = backendOrder(set.source).filter((name) =>
                  name === "ytdlp" ? ytdlp.isConfigured : cobalt.isConfigured
                );
                const backend = yield* fetchWithFallback(
                  backends.map((name) => ({
                    name,
                    run:
                      name === "ytdlp"
                        ? ytdlp.download(
                            set.url,
                            tmpPath,
                            onProgress,
                            abort.signal
                          )
                        : fetchCobalt,
                  })),
                  set.id,
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
            const outcome = yield* Effect.exit(downloadOne(claimed));
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
