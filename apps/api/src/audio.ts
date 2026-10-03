import { Effect, Layer } from "effect";

import { Audio } from "../../server/src/audio-service.js";
import { LibraryError } from "../../server/src/errors.js";
import { Library } from "../../server/src/library.js";

export const audioLayer = Layer.succeed(Audio, {
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
      return {
        bytesReceived: set.retainedAudioBytes ?? 0,
        bytesTotal: set.retainedAudioBytes,
        format: set.retainedAudioFormat,
        state: set.downloadState,
      };
    }),
  cancelDownload: (id) =>
    Library.pipe(Effect.flatMap((library) => library.cancelDownload(id))),
  isConfigured: true,
  processNext: () => Effect.succeed(false),
  requestDownload: (id) =>
    Effect.gen(function* queueDownload() {
      const library = yield* Library;
      const current = yield* library.find(id);
      if (!["none", "failed", "canceled"].includes(current.downloadState)) {
        return { accepted: false, set: current };
      }
      return { accepted: true, set: yield* library.queueDownload(id) };
    }),
});
