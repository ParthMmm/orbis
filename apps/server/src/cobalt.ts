import { Context, Effect, Layer, Schema } from "effect";

import { LibraryError } from "./errors.js";

export interface CobaltOptions {
  readonly cobaltUrl?: string | undefined;
  readonly cobaltApiKey?: string | undefined;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const COBALT_TIMEOUT_MS = 10 * 60 * 1000;

const CobaltTunnel = Schema.Struct({
  status: Schema.Literal("tunnel"),
  url: Schema.String,
});

const downloadFailed = (reason: string) =>
  new LibraryError({ message: reason, statusCode: 500 });

const fetchError = <E>(error: E) =>
  error instanceof LibraryError
    ? error
    : downloadFailed("The download failed before any audio arrived.");

export class Cobalt extends Context.Service<
  Cobalt,
  {
    readonly isConfigured: boolean;
    readonly requestTunnel: (
      sourceUrl: string,
      signal: AbortSignal
    ) => Effect.Effect<string, LibraryError>;
    readonly openTunnel: (
      url: string,
      signal: AbortSignal
    ) => Effect.Effect<Response, LibraryError>;
  }
>()("@orbis/Cobalt") {
  static layer(options: CobaltOptions = {}): Layer.Layer<Cobalt> {
    const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    const configured =
      (options.cobaltUrl?.length ?? 0) > 0 &&
      (options.cobaltApiKey?.length ?? 0) > 0;
    return Layer.succeed(
      Cobalt,
      Cobalt.of({
        isConfigured: configured,
        openTunnel: Effect.fn("Cobalt.openTunnel")(function* openTunnel(
          url: string,
          signal: AbortSignal
        ) {
          const response = yield* Effect.tryPromise({
            catch: fetchError,
            try: () => fetchFn(url, { signal }),
          });
          if (!response.ok || !response.body) {
            return yield* Effect.fail(
              downloadFailed("The audio stream ended before it began.")
            );
          }
          return response;
        }),
        requestTunnel: Effect.fn("Cobalt.requestTunnel")(
          function* requestTunnel(sourceUrl: string, signal: AbortSignal) {
            const cobaltResponse = yield* Effect.tryPromise({
              catch: (error) =>
                error instanceof LibraryError
                  ? error
                  : downloadFailed("Cobalt did not answer in time."),
              try: (requestSignal) => {
                const timeout = AbortSignal.timeout(COBALT_TIMEOUT_MS);
                const combined = AbortSignal.any([requestSignal, timeout]);
                return fetchFn(`${options.cobaltUrl}`, {
                  body: JSON.stringify({
                    alwaysProxy: true,
                    audioFormat: "best",
                    downloadMode: "audio",
                    localProcessing: "disabled",
                    url: sourceUrl,
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
            const tunneled = yield* Schema.decodeUnknownEffect(CobaltTunnel)(
              cobaltResponse
            ).pipe(
              Effect.mapError(() =>
                downloadFailed("Cobalt could not fetch this audio.")
              )
            );
            return tunneled.url;
          }
        ),
      })
    );
  }
}
