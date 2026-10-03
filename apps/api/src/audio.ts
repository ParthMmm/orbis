import { Effect, Layer } from "effect";

import { Audio } from "../../server/src/audio-service.js";
import { LibraryError } from "../../server/src/errors.js";
import { Library } from "../../server/src/library.js";
import type { GroupAudioNode } from "./node.js";

export const makeAudioLayer = (node?: GroupAudioNode) =>
  Layer.succeed(Audio, {
    audioFile: (id) =>
      Effect.gen(function* audioFile() {
        const library = yield* Library;
        const set = yield* library.find(id);
        if (set.downloadState !== "ready" || !set.retainedAudioFormat) {
          return yield* new LibraryError({
            message: "This set has no audio yet.",
            statusCode: 404,
          });
        }
        return {
          bytes: set.retainedAudioBytes ?? 0,
          contentType: "application/octet-stream",
          path: id,
        };
      }),
    audioState: (id) =>
      Effect.gen(function* audioState() {
        const library = yield* Library;
        const set = yield* library.find(id);
        const live = node?.progressFor(id);
        return {
          bytesReceived: live?.received ?? set.retainedAudioBytes ?? 0,
          bytesTotal: live?.total ?? set.retainedAudioBytes,
          format: set.retainedAudioFormat,
          state: set.downloadState,
        };
      }),
    cancelDownload: (id) =>
      Effect.gen(function* cancelDownload() {
        const library = yield* Library;
        const set = yield* library.cancelDownload(id);
        if (node) {
          yield* Effect.promise(() => node.cancel(id));
        }
        return set;
      }),
    isConfigured: true,
    processNext: () => Effect.succeed(false),
    requestDownload: (id) =>
      Effect.gen(function* queueDownload() {
        const library = yield* Library;
        const current = yield* library.find(id);
        if (!["none", "failed", "canceled"].includes(current.downloadState)) {
          return { accepted: false, set: current };
        }
        const set = yield* library.queueDownload(id);
        if (node) {
          yield* Effect.promise(() => node.wake());
        }
        return { accepted: true, set };
      }),
  });

export const audioLayer = makeAudioLayer();
