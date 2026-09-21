import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { Context, Effect, Layer, Schema } from "effect";

import { LibraryError } from "./errors.js";

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
            const { done, value } = yield* Effect.promise(() => reader.read());
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
        return yield* Effect.fail(
          downloadFailed("Cobalt delivered an unsupported container.")
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
          ["part", "ogg", "mp3"].map((suffix) =>
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
