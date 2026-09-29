import type { SavedSet } from "@orbis/contracts";
import { Context, Effect, Layer } from "effect";

import { Cobalt } from "./cobalt.js";
import { LibraryError } from "./errors.js";
import { MediaStore } from "./media-store.js";
import { Ytdlp } from "./ytdlp.js";

export type BackendName = "cobalt" | "ytdlp";

// Each source goes first to the backend proven on it; the other is the safety net.
export const backendOrder = (source: SavedSet["source"]) =>
  source === "youtube"
    ? (["ytdlp", "cobalt"] as const)
    : (["cobalt", "ytdlp"] as const);

/**
 * The download backends behind one interface: which to try for a source, in order,
 * and a fetch of one Source Link into a partial file. The worker and the canary both
 * download through here, so a fix to a backend reaches both. Each fetch logs its
 * evidence, and building the layer warns when a source has no safety net.
 */
export class DownloadBackends extends Context.Service<
  DownloadBackends,
  {
    /** The configured backends for a source, in the order to try them. Empty when none is. */
    readonly forSource: (source: SavedSet["source"]) => readonly BackendName[];
    /** Downloads `url` into `destination`. Fails when the backend delivers no audio. */
    readonly fetch: (
      backend: BackendName,
      url: string,
      destination: string,
      onProgress: (received: number, total: number | null) => void,
      signal: AbortSignal
    ) => Effect.Effect<void, LibraryError>;
  }
>()("@orbis/DownloadBackends") {
  static readonly layer: Layer.Layer<
    DownloadBackends,
    never,
    Cobalt | MediaStore | Ytdlp
  > = Layer.effect(
    DownloadBackends,
    Effect.gen(function* buildBackends() {
      const cobalt = yield* Cobalt;
      const media = yield* MediaStore;
      const ytdlp = yield* Ytdlp;
      const configured = (name: BackendName) =>
        name === "ytdlp" ? ytdlp.isConfigured : cobalt.isConfigured;
      const forSource = (source: SavedSet["source"]) =>
        backendOrder(source).filter(configured);
      // A source with one backend has no safety net, so say so before a download fails.
      for (const source of ["youtube", "soundcloud"] as const) {
        const [only, second] = forSource(source);
        if (second === undefined) {
          yield* Effect.logWarning(
            only === undefined
              ? `${source} downloads have no backend`
              : `${source} downloads use ${only} only`
          ).pipe(
            Effect.annotateLogs({
              fix: ytdlp.isConfigured
                ? "Set ORBIS_COBALT_URL and ORBIS_COBALT_API_KEY."
                : "Set ORBIS_YTDLP_BIN to an absolute yt-dlp path.",
            })
          );
        }
      }
      const viaCobalt = Effect.fn("DownloadBackends.viaCobalt")(
        function* viaCobalt(
          url: string,
          destination: string,
          onProgress: (received: number, total: number | null) => void,
          signal: AbortSignal
        ) {
          const tunnelUrl = yield* cobalt.requestTunnel(url, signal);
          const response = yield* cobalt.openTunnel(tunnelUrl, signal);
          yield* Effect.logInfo("cobalt tunnel opened").pipe(
            Effect.annotateLogs({
              contentLength: response.headers.get("content-length") ?? "none",
              status: response.status,
            })
          );
          yield* media.streamResponse(
            response,
            destination,
            onProgress,
            signal
          );
          // Cobalt can answer a YouTube tunnel with 200 and no bytes.
          if (Bun.file(destination).size === 0) {
            return yield* Effect.fail(
              new LibraryError({
                message: "Cobalt sent an empty stream.",
                statusCode: 500,
              })
            );
          }
        }
      );
      return DownloadBackends.of({
        fetch: (backend, url, destination, onProgress, signal) =>
          backend === "ytdlp"
            ? ytdlp.download(url, destination, onProgress, signal)
            : viaCobalt(url, destination, onProgress, signal),
        forSource,
      });
    })
  );
}
