import type { Cue, SetSource } from "@orbis/contracts";
import { CueSchema } from "@orbis/contracts/http-api";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

import { VersosError } from "./versos-error.js";

export { VersosError } from "./versos-error.js";

export interface TracklistRequest {
  readonly description: string | null;
  readonly source: SetSource;
  readonly url: string;
}

export type TracklistPoll =
  | { readonly state: "pending" }
  | { readonly state: "none" }
  | { readonly state: "ready"; readonly cues: readonly Cue[] };

export interface VersosService {
  readonly request: (
    input: TracklistRequest
  ) => Effect.Effect<{ readonly requestId: string }, VersosError>;
  readonly poll: (
    requestId: string
  ) => Effect.Effect<TracklistPoll, VersosError>;
}

type RequestFetch = (url: URL, init: RequestInit) => Promise<Response>;

const RequestResponse = Schema.Struct({ requestId: Schema.String });
const PollResponse = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    cues: Schema.Array(CueSchema),
    state: Schema.Literal("ready"),
  }),
]);

const unconfigured: VersosService = {
  poll: () => Effect.fail(new VersosError({ reason: "not-configured" })),
  request: () => Effect.fail(new VersosError({ reason: "not-configured" })),
};

export class Versos extends Context.Service<Versos, VersosService>()(
  "@orbis/Versos"
) {
  static unconfigured(): Layer.Layer<Versos> {
    return Layer.succeed(Versos, unconfigured);
  }

  static layerOf(service: VersosService): Layer.Layer<Versos> {
    return Layer.succeed(Versos, service);
  }

  static layer(options: {
    readonly url: string;
    readonly key: Redacted.Redacted<string>;
    readonly fetch?: RequestFetch;
    readonly requestTimeoutMs?: number;
  }): Layer.Layer<Versos> {
    const base = new URL(options.url);
    const requestFetch = options.fetch ?? fetch;
    const read = <S extends Schema.ConstraintDecoder<unknown>>(
      endpoint: URL,
      schema: S,
      init: RequestInit
    ): Effect.Effect<S["Type"], VersosError> =>
      Effect.gen(function* readVersos() {
        const response = yield* Effect.tryPromise({
          catch: () => new VersosError({ reason: "unavailable" }),
          try: (signal) => requestFetch(endpoint, { ...init, signal }),
        });
        if (!response.ok) {
          return yield* Effect.fail(
            new VersosError({
              reason: response.status >= 500 ? "unavailable" : "rejected",
            })
          );
        }
        const body: unknown = yield* Effect.tryPromise({
          catch: () => new VersosError({ reason: "unexpected-response" }),
          try: () => response.json(),
        });
        const parsed = Schema.decodeUnknownOption(schema)(body);
        if (Option.isNone(parsed)) {
          return yield* Effect.fail(
            new VersosError({ reason: "unexpected-response" })
          );
        }
        return parsed.value;
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.requestTimeoutMs ?? 10_000,
          orElse: () => Effect.fail(new VersosError({ reason: "unavailable" })),
        })
      );
    const headers = {
      authorization: `Bearer ${Redacted.value(options.key)}`,
      "content-type": "application/json",
    };
    return Versos.layerOf({
      poll: (requestId) =>
        read(
          new URL(`/orbis/tracklists/${encodeURIComponent(requestId)}`, base),
          PollResponse,
          { headers, method: "GET" }
        ),
      request: (input) =>
        read(new URL("/orbis/tracklists", base), RequestResponse, {
          body: JSON.stringify(input),
          headers,
          method: "POST",
        }),
    });
  }

  static layerConfig(): Layer.Layer<Versos> {
    return Layer.unwrap(
      Effect.gen(function* readVersosConfig() {
        const url = yield* Config.option(Config.URL("VERSOS_URL"));
        const key = yield* Config.option(Config.Redacted("VERSOS_ORBIS_KEY"));
        return Option.isSome(url) && Option.isSome(key)
          ? Versos.layer({ key: key.value, url: url.value.toString() })
          : Versos.unconfigured();
      }).pipe(
        Effect.catchTag("ConfigError", () =>
          Effect.succeed(Versos.unconfigured())
        )
      )
    );
  }
}
