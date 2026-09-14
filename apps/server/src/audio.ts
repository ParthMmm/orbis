import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { AudioState, SavedSet } from "@orbis/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { LibraryError } from "./errors.js";
import { Library } from "./library.js";

export interface AudioOptions {
  readonly audioDir?: string;
  readonly cobaltUrl?: string | undefined;
  readonly cobaltApiKey?: string | undefined;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly ffprobePath?: string;
  readonly ffmpegPath?: string;
  readonly pollIntervalMs?: number;
  readonly startWorker?: boolean;
}

export interface AudioFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: number;
}

// Two gibibytes caps one stored download. Six hours at the richest source bitrate is an
// order of magnitude smaller; anything past the cap is a stuck stream, not a set.
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const COBALT_TIMEOUT_MS = 10 * 60 * 1000;

const contentTypeFor = (format: string): string | undefined => {
  if (format === "mp3") {
    return "audio/mpeg";
  }
  if (format === "ogg") {
    return "audio/ogg";
  }
  return undefined;
};

// Cobalt answers a processing request with one JSON shape per outcome. Only the tunnel
// carries a URL, so only it decodes; every other outcome is a failed download.
const CobaltTunnel = Schema.Struct({
  status: Schema.Literal("tunnel"),
  url: Schema.String,
});

const ProbeFormat = Schema.Struct({
  format: Schema.Struct({
    duration: Schema.String,
    format_name: Schema.String,
  }),
});

const unconfigured = () =>
  new LibraryError({
    message: "Audio downloads are not configured on this server.",
    statusCode: 503,
  });

const downloadFailed = (reason: string) =>
  new LibraryError({ message: reason, statusCode: 500 });

const fetchError = <E>(error: E) =>
  error instanceof LibraryError
    ? error
    : downloadFailed("The download failed before any audio arrived.");

export class Audio extends Context.Service<
  Audio,
  {
    readonly isConfigured: boolean;
    readonly requestDownload: (
      id: string
    ) => Effect.Effect<{ set: SavedSet; accepted: boolean }, LibraryError>;
    readonly audioState: (
      id: string
    ) => Effect.Effect<AudioState, LibraryError>;
    readonly audioFile: (id: string) => Effect.Effect<AudioFile, LibraryError>;
    readonly cancelDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly processNext: () => Effect.Effect<boolean, never>;
  }
>()("@orbis/Audio") {
  static layer(options: AudioOptions = {}): Layer.Layer<Audio, never, Library> {
    const audioDir = options.audioDir ?? path.join(".", "audio");
    const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    const ffprobePath = options.ffprobePath ?? "ffprobe";
    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const configured =
      (options.cobaltUrl?.length ?? 0) > 0 &&
      (options.cobaltApiKey?.length ?? 0) > 0;
    return Layer.effect(
      Audio,
      Effect.gen(function* buildAudio() {
        const library = yield* Library;
        yield* Effect.promise(() => mkdir(audioDir, { recursive: true }));
        yield* library.resetStuckDownloads().pipe(Effect.orDie);
        const progress = new Map<
          string,
          { received: number; total: number | null }
        >();
        const aborts = new Map<string, AbortController>();
        const fileFor = (id: string, format: string) =>
          path.join(audioDir, `${id}.${format}`);

        const requestDownload = Effect.fn("Audio.requestDownload")(
          function* requestDownload(id: string) {
            if (!configured) {
              return yield* Effect.fail(unconfigured());
            }
            const current = yield* library.find(id);
            if (current.downloadState !== "none") {
              return { accepted: false, set: current };
            }
            return {
              accepted: true,
              set: yield* library.queueDownload(id),
            };
          }
        );
        const audioState = Effect.fn("Audio.audioState")(function* audioState(
          id: string
        ) {
          const set = yield* library.find(id);
          const live = progress.get(id);
          return {
            bytesReceived: live?.received ?? set.retainedAudioBytes ?? 0,
            bytesTotal: live?.total ?? set.retainedAudioBytes ?? null,
            format: set.retainedAudioFormat,
            state: set.downloadState,
          } satisfies AudioState;
        });
        const audioFile = Effect.fn("Audio.audioFile")(function* audioFile(
          id: string
        ) {
          const set = yield* library.find(id);
          const contentType = set.retainedAudioFormat
            ? contentTypeFor(set.retainedAudioFormat)
            : undefined;
          if (
            set.downloadState !== "ready" ||
            !set.retainedAudioFormat ||
            !contentType
          ) {
            return yield* Effect.fail(
              new LibraryError({
                message: "This set has no audio yet.",
                statusCode: 404,
              })
            );
          }
          const filePath = fileFor(id, set.retainedAudioFormat);
          const file = Bun.file(filePath);
          if (!(yield* Effect.promise(() => file.exists()))) {
            return yield* Effect.fail(
              new LibraryError({
                message: "Could not complete the library request.",
                statusCode: 500,
              })
            );
          }
          return {
            bytes: file.size,
            contentType,
            path: filePath,
          } satisfies AudioFile;
        });
        // A missing partial is the normal case after a clean finish, so each removal
        // absorbs its own failure and the three run together.
        const removeFiles = (id: string) =>
          Effect.promise(() =>
            Promise.allSettled(
              ["part", "ogg", "mp3"].map((suffix) =>
                rm(path.join(audioDir, `${id}.${suffix}`), { force: true })
              )
            )
          );
        const cancelDownload = Effect.fn("Audio.cancelDownload")(
          function* cancelDownload(id: string) {
            aborts.get(id)?.abort();
            aborts.delete(id);
            progress.delete(id);
            yield* removeFiles(id);
            return yield* library.cancelDownload(id);
          }
        );
        const runCommand = Effect.fn("Audio.runCommand")(function* runCommand(
          command: string,
          args: readonly string[]
        ) {
          const ran = yield* Effect.promise(() =>
            (async () => {
              const proc = Bun.spawn([command, ...args], {
                stderr: "ignore",
                stdout: "pipe",
              });
              const [output, code] = await Promise.all([
                new Response(proc.stdout).text(),
                proc.exited,
              ]);
              return { code, output };
            })()
          );
          if (ran.code !== 0) {
            return yield* Effect.fail(
              downloadFailed("The downloaded audio could not be read.")
            );
          }
          return ran.output;
        });
        const probe = Effect.fn("Audio.probe")(function* probe(
          filePath: string
        ) {
          const output = yield* runCommand(ffprobePath, [
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration",
            "-of",
            "json",
            filePath,
          ]);
          const probed = yield* Schema.decodeUnknownEffect(ProbeFormat)(
            JSON.parse(output)
          ).pipe(
            Effect.mapError(() =>
              downloadFailed("The downloaded audio could not be read.")
            )
          );
          const durationSeconds = Number(probed.format.duration);
          if (!Number.isFinite(durationSeconds)) {
            return yield* Effect.fail(
              downloadFailed("The downloaded audio could not be read.")
            );
          }
          return {
            container: probed.format.format_name,
            durationSeconds,
          };
        });
        const downloadOne = Effect.fn("Audio.downloadOne")(
          function* downloadOne(set: SavedSet) {
            const tmpPath = path.join(audioDir, `${set.id}.part`);
            const abort = new AbortController();
            aborts.set(set.id, abort);
            progress.set(set.id, { received: 0, total: null });
            yield* Effect.ensuring(
              Effect.gen(function* runDownload() {
                const cobaltResponse = yield* Effect.tryPromise({
                  catch: (error) =>
                    error instanceof LibraryError
                      ? error
                      : downloadFailed("Cobalt did not answer in time."),
                  try: (signal) => {
                    const timeout = AbortSignal.timeout(COBALT_TIMEOUT_MS);
                    const combined = AbortSignal.any([signal, timeout]);
                    return fetchFn(`${options.cobaltUrl}`, {
                      body: JSON.stringify({
                        alwaysProxy: true,
                        audioFormat: "best",
                        downloadMode: "audio",
                        localProcessing: "disabled",
                        url: set.url,
                      }),
                      headers: {
                        accept: "application/json",
                        authorization: `Api-Key ${options.cobaltApiKey}`,
                        "content-type": "application/json",
                      },
                      method: "POST",
                      signal: combined,
                    })
                      .then(async (response) => {
                        if (!response.ok) {
                          throw downloadFailed(
                            "Cobalt refused the download request."
                          );
                        }
                        // SAFETY: Cobalt's response shape is asserted by the
                        // CobaltTunnel Schema decode below; this only crosses
                        // the JSON boundary.
                        return (await response.json()) as unknown;
                      })
                      .catch(() => {
                        throw downloadFailed(
                          timeout.aborted
                            ? "Cobalt did not answer in time."
                            : "Cobalt could not be reached."
                        );
                      });
                  },
                });
                const tunneled = yield* Schema.decodeUnknownEffect(
                  CobaltTunnel
                )(cobaltResponse).pipe(
                  Effect.mapError(() =>
                    downloadFailed("Cobalt could not fetch this audio.")
                  )
                );
                const tunnel = yield* Effect.tryPromise({
                  catch: fetchError,
                  try: () => fetchFn(tunneled.url, { signal: abort.signal }),
                });
                if (!tunnel.ok || !tunnel.body) {
                  return yield* Effect.fail(
                    downloadFailed("The audio stream ended before it began.")
                  );
                }
                const totalHeader = tunnel.headers.get("content-length");
                const total = totalHeader ? Number(totalHeader) : null;
                const writer = Bun.file(tmpPath).writer();
                const drain = (
                  reader: ReadableStreamDefaultReader<Uint8Array>,
                  received: number
                ): Effect.Effect<number, LibraryError> =>
                  Effect.gen(function* drainChunk() {
                    const { done, value } = yield* Effect.promise(() =>
                      reader.read()
                    );
                    if (done) {
                      return received;
                    }
                    const next = received + value.byteLength;
                    if (next > MAX_AUDIO_BYTES) {
                      return yield* Effect.fail(
                        downloadFailed("The audio exceeded the size bound.")
                      );
                    }
                    writer.write(value);
                    progress.set(set.id, {
                      received: next,
                      total: Number.isFinite(total) ? total : null,
                    });
                    return yield* drain(reader, next);
                  });
                try {
                  yield* drain(tunnel.body.getReader(), 0);
                } finally {
                  writer.end();
                }
                const { container, durationSeconds } = yield* probe(tmpPath);
                if (/matroska|webm/u.test(container)) {
                  // YouTube's Opus arrives in a container AVFoundation refuses. The remux
                  // copies the audio bit for bit into Ogg, which it plays and seeks.
                  const finalPath = fileFor(set.id, "ogg");
                  yield* runCommand(ffmpegPath, [
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    tmpPath,
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "copy",
                    finalPath,
                  ]).pipe(
                    Effect.mapError(() =>
                      downloadFailed(
                        "The downloaded audio could not be stored."
                      )
                    )
                  );
                  yield* Effect.promise(() => rm(tmpPath, { force: true }));
                  return yield* library.finishDownload(set.id, {
                    bytes: Bun.file(finalPath).size,
                    durationSeconds,
                    format: "ogg",
                  });
                }
                if (container === "mp3" || container === "ogg") {
                  const format = container;
                  yield* Effect.promise(() =>
                    rename(tmpPath, fileFor(set.id, format))
                  );
                  return yield* library.finishDownload(set.id, {
                    bytes: Bun.file(fileFor(set.id, format)).size,
                    durationSeconds,
                    format,
                  });
                }
                return yield* Effect.fail(
                  downloadFailed("Cobalt delivered an unsupported container.")
                );
              }),
              Effect.gen(function* cleanupDownload() {
                yield* Effect.ignore(
                  Effect.promise(() => rm(tmpPath, { force: true }))
                );
              })
            );
          }
        );
        // Every failure path above throws a LibraryError with the reason the response
        // carries, so the worker records it and moves on instead of dying on one set.
        const processNext = Effect.fn("Audio.processNext")(() =>
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
            // The run's own maps clear whether it finished, failed, or was canceled.
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
        if (options.startWorker === true) {
          yield* Effect.forkScoped(
            Effect.forever(
              processNext().pipe(
                // processNext never fails: a broken round logs inside and reports false,
                // so the loop only decides between working and sleeping.
                Effect.flatMap((worked) =>
                  worked ? Effect.void : Effect.sleep(pollIntervalMs)
                )
              )
            )
          );
        }
        return {
          audioFile,
          audioState,
          cancelDownload,
          isConfigured: configured,
          processNext,
          requestDownload,
        };
      })
    );
  }
}
