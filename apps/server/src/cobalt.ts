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
const CobaltErrorStatus = Schema.Struct({ status: Schema.Literal("error") });
const CobaltProviderCode = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
});

type CobaltRequestFailure =
  | { readonly kind: "timeout" | "transport" }
  | {
      readonly kind: "http" | "provider";
      readonly status: number;
      readonly code: string;
    }
  | {
      readonly kind: "malformed";
      readonly status: number;
    };

const FAILURE_REASONS = {
  http: "Cobalt refused the download request.",
  malformed: "Cobalt sent a malformed response.",
  provider: "Cobalt could not fetch this audio.",
  timeout: "Cobalt did not answer in time.",
  transport: "Cobalt could not be reached.",
} satisfies Readonly<Record<CobaltRequestFailure["kind"], string>>;

const safeProviderCode = (code: string): string =>
  code.length <= 80 && /^[a-z0-9._-]+$/iu.test(code)
    ? code
    : "cobalt_error_unknown";

const downloadFailed = (reason: string) =>
  new LibraryError({ message: reason, statusCode: 500 });

const failRequest = (failure: CobaltRequestFailure) => {
  const annotations = {
    cobaltFailure: failure.kind,
    cobaltProviderCode: "code" in failure ? failure.code : undefined,
    cobaltStatus: "status" in failure ? failure.status : undefined,
  };
  return Effect.logWarning("cobalt request failed").pipe(
    Effect.annotateLogs(annotations),
    Effect.andThen(Effect.fail(downloadFailed(FAILURE_REASONS[failure.kind])))
  );
};

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
            const timeout = AbortSignal.timeout(COBALT_TIMEOUT_MS);
            const response = yield* Effect.tryPromise({
              catch: (error): CobaltRequestFailure =>
                timeout.aborted ||
                (error instanceof Error && error.name === "TimeoutError")
                  ? {
                      kind: "timeout",
                    }
                  : {
                      kind: "transport",
                    },
              try: (requestSignal) => {
                const combined = AbortSignal.any([
                  requestSignal,
                  timeout,
                  signal,
                ]);
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
                });
              },
            }).pipe(Effect.catch(failRequest));
            const cobaltResponse: unknown = yield* Effect.promise(() =>
              response.json().catch(() => null)
            );
            const code = Schema.is(CobaltProviderCode)(cobaltResponse)
              ? safeProviderCode(cobaltResponse.error.code)
              : "cobalt_error_unknown";
            if (!response.ok) {
              return yield* failRequest({
                code,
                kind: "http",
                status: response.status,
              });
            }
            if (Schema.is(CobaltErrorStatus)(cobaltResponse)) {
              return yield* failRequest({
                code,
                kind: "provider",
                status: response.status,
              });
            }
            const tunneled = yield* Schema.decodeUnknownEffect(CobaltTunnel)(
              cobaltResponse
            ).pipe(
              Effect.catch(() =>
                failRequest({
                  kind: "malformed",
                  status: response.status,
                })
              )
            );
            return tunneled.url;
          }
        ),
      })
    );
  }
}
