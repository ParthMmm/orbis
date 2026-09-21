import type { AudioState, SavedSet } from "@orbis/contracts";
import { Context, Effect, Layer } from "effect";

import { Cobalt } from "./cobalt.js";
import type { CobaltOptions } from "./cobalt.js";
import { DownloadWorker } from "./download-worker.js";
import type { DownloadWorkerOptions } from "./download-worker.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
import { MediaStore } from "./media-store.js";
import type { MediaFile, MediaStoreOptions } from "./media-store.js";

export interface AudioOptions
  extends CobaltOptions, MediaStoreOptions, DownloadWorkerOptions {}

export type AudioFile = MediaFile;

const unconfigured = () =>
  new LibraryError({
    message: "Audio downloads are not configured on this server.",
    statusCode: 503,
  });

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
    const cobaltLayer = Cobalt.layer(options);
    const mediaLayer = MediaStore.layer(options);
    const workerLayer = DownloadWorker.layer(options).pipe(
      Layer.provide(cobaltLayer),
      Layer.provide(mediaLayer)
    );
    return Layer.effect(
      Audio,
      Effect.gen(function* buildAudio() {
        const library = yield* Library;
        const cobalt = yield* Cobalt;
        const media = yield* MediaStore;
        const worker = yield* DownloadWorker;
        yield* media.ensureDirectory();
        const requestDownload = Effect.fn("Audio.requestDownload")(
          function* requestDownload(id: string) {
            if (!cobalt.isConfigured) {
              return yield* Effect.fail(unconfigured());
            }
            const current = yield* library.find(id);
            const retriable = ["none", "failed", "canceled"].includes(
              current.downloadState
            );
            if (!retriable) {
              yield* Effect.logInfo("audio download already have").pipe(
                Effect.annotateLogs({ set: id, state: current.downloadState })
              );
              return { accepted: false, set: current };
            }
            const queued = yield* library.queueDownload(id);
            yield* worker.wake();
            yield* Effect.logInfo("audio download queued").pipe(
              Effect.annotateLogs({
                set: id,
                from: current.downloadState,
              })
            );
            return { accepted: true, set: queued };
          }
        );
        const audioState = Effect.fn("Audio.audioState")(function* audioState(
          id: string
        ) {
          const set = yield* library.find(id);
          const live = worker.progressFor(id);
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
          if (set.downloadState !== "ready" || !set.retainedAudioFormat) {
            return yield* Effect.fail(
              new LibraryError({
                message: "This set has no audio yet.",
                statusCode: 404,
              })
            );
          }
          return yield* media.readReady(id, set.retainedAudioFormat);
        });
        const cancelDownload = Effect.fn("Audio.cancelDownload")(
          function* cancelDownload(id: string) {
            worker.abort(id);
            yield* media.removeFiles(id);
            const canceled = yield* library.cancelDownload(id);
            yield* Effect.logInfo("audio download canceled").pipe(
              Effect.annotateLogs({ set: id, state: canceled.downloadState })
            );
            return canceled;
          }
        );
        return {
          audioFile,
          audioState,
          cancelDownload,
          isConfigured: cobalt.isConfigured,
          processNext: worker.processNext,
          requestDownload,
        };
      })
    ).pipe(
      Layer.provide(workerLayer),
      Layer.provideMerge(cobaltLayer),
      Layer.provideMerge(mediaLayer)
    );
  }
}
