import { OrbisApi } from "@orbis/contracts/http-api";
import { Effect } from "effect";
import type { Effect as EffectType, Success } from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

/**
 * Why a call failed. `unreachable` means no response arrived at all: the API is
 * down, or Chrome's Local Network Access prompt was denied on a tailnet device
 * (see README, "Devices on the tailnet").
 */
export type ApiFailure = "rejected" | "unreachable" | "failed";

export type ApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ApiFailure };

const failureFor = (status: number | undefined): ApiFailure => {
  if (status === undefined) {
    return "unreachable";
  }
  return status === 401 ? "rejected" : "failed";
};

const makeClient = (apiUrl: string, key: string) =>
  HttpApiClient.make(OrbisApi, {
    baseUrl: apiUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("authorization", `Bearer ${key}`)
    ),
  });
type OrbisClient = Success<ReturnType<typeof makeClient>>;

/** Runs one typed call with a Person's key. It resolves; a failure is a value. */
const call = async <A, E>(
  apiUrl: string,
  key: string,
  operation: (client: OrbisClient) => EffectType<A, E>
): Promise<ApiResult<A>> => {
  let status: number | undefined;
  const trackedFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      ({ status } = response);
      return response;
    },
    { preconnect: fetch.preconnect }
  );
  try {
    const value = await Effect.runPromise(
      Effect.gen(function* request() {
        const client = yield* makeClient(apiUrl, key);
        return yield* operation(client);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, trackedFetch),
        // A `traceparent` header would fail the API's CORS preflight, which allows
        // only the headers the page sends on purpose.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      )
    );
    return { ok: true, value };
  } catch {
    return { failure: failureFor(status), ok: false };
  }
};

export const orbis = (apiUrl: string, key: string) => ({
  me: () => call(apiUrl, key, (client) => client.people.me()),
});
