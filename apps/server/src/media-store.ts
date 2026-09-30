import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { Database } from "./db/database.js";
import { downloadJobs, setCues, sets } from "./db/schema.js";
import { LibraryError } from "./errors.js";
import { outputTail } from "./logging.js";

const releaseError = <E>(error: E) =>
  error instanceof LibraryError
    ? error
    : new LibraryError({
        message: "Could not release audio.",
        statusCode: 500,
      });

export interface MediaStoreOptions {
  readonly audioDir?: string;
  readonly ffprobePath?: string;
  readonly ffmpegPath?: string;
}

export interface StoredAudio {
  readonly bytes: number;
  readonly durationSeconds: number;
  readonly format: string;
}

export interface MediaFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: number;
}

// Two gibibytes caps one stored download. Six hours at the richest source bitrate is an
// order of magnitude smaller; anything past the cap is a stuck stream, not a set.
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;

const ProbeFormat = Schema.Struct({
  format: Schema.Struct({
    duration: Schema.String,
    format_name: Schema.String,
  }),
});

const contentTypeFor = (format: string): string | undefined => {
  if (format === "mp3") {
    return "audio/mpeg";
  }
  if (format === "ogg") {
    return "audio/ogg";
  }
  if (format === "m4a") {
    return "audio/mp4";
  }
  return undefined;
};

const downloadFailed = (reason: string) =>
  new LibraryError({ message: reason, statusCode: 500 });

export class MediaStore extends Context.Service<
  MediaStore,
  {
    readonly fileFor: (id: string, format: string) => string;
    readonly partialPath: (id: string) => string;
    readonly ensureDirectory: () => Effect.Effect<void>;
    readonly removeFiles: (id: string) => Effect.Effect<void>;
    readonly streamResponse: (
      response: Response,
      destination: string,
      onProgress: (received: number, total: number | null) => void,
      signal: AbortSignal
    ) => Effect.Effect<void, LibraryError>;
    readonly storeDownloaded: (
      setId: string,
      partialPath: string
    ) => Effect.Effect<StoredAudio, LibraryError>;
    readonly readReady: (
      setId: string,
      format: string
    ) => Effect.Effect<MediaFile, LibraryError>;
  }
>()("@orbis/MediaStore") {
  static release(id: string, options: MediaStoreOptions = {}) {
    return Effect.gen(function* releaseAudio() {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        Effect.gen(function* releaseUnreferencedAudio() {
          const [reference] = yield* tx.all<{ readonly present: number }>(sql`
          SELECT 1 AS present FROM library_entries WHERE set_id = ${id}
          UNION ALL SELECT 1 AS present FROM playlist_sets WHERE set_id = ${id}
          UNION ALL SELECT 1 AS present FROM queue_entries WHERE set_id = ${id}
          LIMIT 1
        `);
          if (reference) {
            return;
          }
          const directory = options.audioDir ?? path.join(".", "audio");
          yield* Effect.tryPromise({
            catch: () =>
              new LibraryError({
                message: "Could not release audio.",
                statusCode: 500,
              }),
            try: () =>
              Promise.all(
                ["ogg", "mp3", "m4a"].map((suffix) =>
                  rm(path.join(directory, `${id}.${suffix}`), { force: true })
                )
              ),
          });
          yield* tx
            .update(sets)
            .set({
              downloadState: "none",
              retainedAudioBytes: null,
              retainedAudioFormat: null,
              tracklistState: "pending",
            })
            .where(eq(sets.id, id));
          yield* tx.delete(downloadJobs).where(eq(downloadJobs.setId, id));
          yield* tx.delete(setCues).where(eq(setCues.setId, id));
        })
      );
    }).pipe(Effect.mapError(releaseError));
  }

  static layer(options: MediaStoreOptions = {}): Layer.Layer<MediaStore> {
    const audioDir = options.audioDir ?? path.join(".", "audio");
    const ffprobePath = options.ffprobePath ?? "ffprobe";
    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    const fileFor = (id: string, format: string) =>
      path.join(audioDir, `${id}.${format}`);
    const partialPath = (id: string) => path.join(audioDir, `${id}.part`);
    const runCommand = Effect.fn("MediaStore.runCommand")(function* runCommand(
      command: string,
      args: readonly string[]
    ) {
      const ran = yield* Effect.promise(() =>
        (async () => {
          const proc = Bun.spawn([command, ...args], {
            stderr: "pipe",
            stdout: "pipe",
          });
          const [output, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { code, output, stderr };
        })()
      );
      if (ran.code !== 0) {
        yield* Effect.logWarning("media command failed").pipe(
          Effect.annotateLogs({
            command: path.basename(command),
            exitCode: ran.code,
            stderr: outputTail(ran.stderr),
          })
        );
        return yield* Effect.fail(
          downloadFailed("The downloaded audio could not be read.")
        );
      }
      return ran.output;
    });
    const probe = Effect.fn("MediaStore.probe")(function* probe(
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
        Effect.tapError(() =>
          Effect.logWarning("ffprobe output did not parse").pipe(
            Effect.annotateLogs({ output: outputTail(output) })
          )
        ),
        Effect.mapError(() =>
          downloadFailed("The downloaded audio could not be read.")
        )
      );
      const durationSeconds = Number(probed.format.duration);
      if (!Number.isFinite(durationSeconds)) {
        yield* Effect.logWarning("ffprobe reported no duration").pipe(
          Effect.annotateLogs({ container: probed.format.format_name })
        );
        return yield* Effect.fail(
          downloadFailed("The downloaded audio could not be read.")
        );
      }
      return {
        container: probed.format.format_name,
        durationSeconds,
      };
    });
    const streamResponse = Effect.fn("MediaStore.streamResponse")(
      function* streamResponse(
        response: Response,
        destination: string,
        onProgress: (received: number, total: number | null) => void,
        signal: AbortSignal
      ) {
        if (!response.body) {
          return yield* Effect.fail(
            downloadFailed("The audio stream ended before it began.")
          );
        }
        const totalHeader = response.headers.get("content-length");
        const total = totalHeader ? Number(totalHeader) : null;
        const writer = Bun.file(destination).writer();
        const drain = (
          reader: ReadableStreamDefaultReader<Uint8Array>,
          received: number
        ): Effect.Effect<number, LibraryError> =>
          Effect.gen(function* drainChunk() {
            if (signal.aborted) {
              return yield* Effect.fail(
                downloadFailed("The download was canceled.")
              );
            }
            const { done, value } = yield* Effect.tryPromise({
              catch: () =>
                downloadFailed(
                  signal.aborted
                    ? "The download was canceled."
                    : "The audio stream broke off."
                ),
              try: () => reader.read(),
            });
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
            onProgress(next, Number.isFinite(total) ? total : null);
            return yield* drain(reader, next);
          });
        try {
          yield* drain(response.body.getReader(), 0);
        } finally {
          writer.end();
        }
      }
    );
    const storeDownloaded = Effect.fn("MediaStore.storeDownloaded")(
      function* storeDownloaded(setId: string, tmpPath: string) {
        if (Bun.file(tmpPath).size === 0) {
          return yield* Effect.fail(downloadFailed("The download was empty."));
        }
        const { container, durationSeconds } = yield* probe(tmpPath);
        if (/matroska|webm/u.test(container)) {
          const finalPath = fileFor(setId, "ogg");
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
              downloadFailed("The downloaded audio could not be stored.")
            )
          );
          yield* Effect.promise(() => rm(tmpPath, { force: true }));
          return {
            bytes: Bun.file(finalPath).size,
            durationSeconds,
            format: "ogg",
          } satisfies StoredAudio;
        }
        if (container === "mp3" || container === "ogg") {
          const format = container;
          yield* Effect.promise(() => rename(tmpPath, fileFor(setId, format)));
          return {
            bytes: Bun.file(fileFor(setId, format)).size,
            durationSeconds,
            format,
          } satisfies StoredAudio;
        }
        // The stored format follows the source codec; m4a is kept as delivered.
        if (/mp4|m4a/u.test(container)) {
          yield* Effect.promise(() => rename(tmpPath, fileFor(setId, "m4a")));
          return {
            bytes: Bun.file(fileFor(setId, "m4a")).size,
            durationSeconds,
            format: "m4a",
          } satisfies StoredAudio;
        }
        return yield* Effect.fail(
          downloadFailed("The download delivered an unsupported container.")
        );
      }
    );
    const readReady = Effect.fn("MediaStore.readReady")(function* readReady(
      setId: string,
      format: string
    ) {
      const contentType = contentTypeFor(format);
      if (!contentType) {
        return yield* Effect.fail(
          new LibraryError({
            message: "This set has no audio yet.",
            statusCode: 404,
          })
        );
      }
      const filePath = fileFor(setId, format);
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
      } satisfies MediaFile;
    });
    const removeFiles = Effect.fn("MediaStore.removeFiles")((id: string) =>
      Effect.promise(() =>
        Promise.allSettled(
          ["part", "ogg", "mp3", "m4a"].map((suffix) =>
            rm(path.join(audioDir, `${id}.${suffix}`), { force: true })
          )
        )
      )
    );
    const ensureDirectory = Effect.fn("MediaStore.ensureDirectory")(() =>
      Effect.promise(() => mkdir(audioDir, { recursive: true }))
    );
    return Layer.succeed(
      MediaStore,
      MediaStore.of({
        ensureDirectory,
        fileFor,
        partialPath,
        readReady,
        removeFiles,
        storeDownloaded,
        streamResponse,
      })
    );
  }
}
