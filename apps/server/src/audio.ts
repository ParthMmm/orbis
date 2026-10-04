import type { AudioState } from "@orbis/contracts";
import { Effect, Layer } from "effect";

import { Audio as AudioService } from "./audio-service.js";
import { Cobalt } from "./cobalt.js";
import type { CobaltOptions } from "./cobalt.js";
import { DownloadBackends } from "./download-backends.js";
import { DownloadWorker } from "./download-worker.js";
import type { DownloadWorkerOptions } from "./download-worker.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
import { MediaStore } from "./media-store.js";
import type { MediaFile, MediaStoreOptions } from "./media-store.js";
import { Ytdlp } from "./ytdlp.js";
import type { YtdlpOptions } from "./ytdlp.js";

export interface AudioOptions
  extends
    CobaltOptions,
    MediaStoreOptions,
    DownloadWorkerOptions,
    YtdlpOptions {}

export type AudioFile = MediaFile;

const unconfigured = () =>
  new LibraryError({
    message: "Audio downloads are not configured on this server.",
    statusCode: 503,
  });

const audioLayer = (
  options: AudioOptions = {}
): Layer.Layer<AudioService, never, Library> => {
  const cobaltLayer = Cobalt.layer(options);
  const ytdlpLayer = Ytdlp.layer(options);
  const mediaLayer = MediaStore.layer(options);
  const backendsLayer = DownloadBackends.layer.pipe(
    Layer.provide(cobaltLayer),
    Layer.provide(ytdlpLayer),
    Layer.provide(mediaLayer)
  );
  const workerLayer = DownloadWorker.layer(options).pipe(
    Layer.provide(backendsLayer),
    Layer.provide(mediaLayer)
  );
  return Layer.effect(
    AudioService,
    Effect.gen(function* buildAudio() {
      const backends = yield* DownloadBackends;
      const media = yield* MediaStore;
      const worker = yield* DownloadWorker;
      // Every backend serves every source, so any configured one is enough.
      const configured = backends.forSource("youtube").length > 0;
      yield* media.ensureDirectory();
      const requestDownload = Effect.fn("Audio.requestDownload")(
        function* requestDownload(id: string) {
          const library = yield* Library;
          if (!configured) {
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
              from: current.downloadState,
              set: id,
            })
          );
          return { accepted: true, set: queued };
        }
      );
      const audioState = Effect.fn("Audio.audioState")(function* audioState(
        id: string
      ) {
        const library = yield* Library;
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
        const library = yield* Library;
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
          const library = yield* Library;
          const canceled = yield* library.cancelDownload(id);
          worker.abort(id);
          yield* media.removeFiles(id);
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
        isConfigured: configured,
        processNext: worker.processNext,
        requestDownload,
      };
    })
  ).pipe(
    Layer.provide(workerLayer),
    Layer.provideMerge(backendsLayer),
    Layer.provideMerge(mediaLayer)
  );
};

export class Audio extends AudioService {
  static readonly layer = audioLayer;
}
