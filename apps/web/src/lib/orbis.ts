import { OrbisApi } from "@orbis/contracts/http-api";
import { Effect, Option, Schema } from "effect";
import type { Effect as EffectType, Success } from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export type ApiFailure =
  | "rejected"
  | "forbidden"
  | "unreachable"
  | "conflict"
  | "limited"
  | "failed";

export type ApiResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly failure: ApiFailure;
      readonly status?: number | undefined;
      readonly message?: string | undefined;
    };

const FAILURE_BY_STATUS: ReadonlyMap<number, ApiFailure> = new Map([
  [401, "rejected"],
  [403, "forbidden"],
  [409, "conflict"],
  [429, "limited"],
]);

const failureFor = (status: number | undefined): ApiFailure =>
  status === undefined
    ? "unreachable"
    : (FAILURE_BY_STATUS.get(status) ?? "failed");

const makeClient = (apiUrl: string, key: string | null) =>
  HttpApiClient.make(OrbisApi, {
    baseUrl: apiUrl,
    transformClient: HttpClient.mapRequest((request) =>
      key === null
        ? request
        : HttpClientRequest.setHeader(request, "authorization", `Bearer ${key}`)
    ),
  });
type OrbisClient = Success<ReturnType<typeof makeClient>>;

export interface Credentials {
  readonly apiUrl: string;
  readonly key: string;
}

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String }))
);

const messageIn = async (
  response: Response | undefined
): Promise<string | undefined> => {
  if (response === undefined) {
    return undefined;
  }
  try {
    return Option.getOrUndefined(decodeErrorBody(await response.text()))
      ?.message;
  } catch {
    return undefined;
  }
};

const run = async <A, E>(
  apiUrl: string,
  key: string | null,
  operation: (client: OrbisClient) => EffectType<A, E>,
  signal?: AbortSignal
): Promise<ApiResult<A>> => {
  let status: number | undefined;
  let refused: Response | undefined;
  const trackedFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      ({ status } = response);
      refused = response.ok ? undefined : response.clone();
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
        // The API's CORS policy does not allow tracing headers.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      ),
      signal === undefined ? undefined : { signal }
    );
    return { ok: true, value };
  } catch {
    return {
      failure: failureFor(status),
      message: await messageIn(refused),
      ok: false,
      status,
    };
  }
};

export const callOrbis = <A, E>(
  { apiUrl, key }: Credentials,
  operation: (client: OrbisClient) => EffectType<A, E>,
  signal?: AbortSignal
): Promise<ApiResult<A>> => run(apiUrl, key, operation, signal);

export const callOrbisWithoutKey = <A, E>(
  apiUrl: string,
  operation: (client: OrbisClient) => EffectType<A, E>
): Promise<ApiResult<A>> => run(apiUrl, null, operation);

export const fetchMe = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.people.me());

export type Person = Extract<
  Awaited<ReturnType<typeof fetchMe>>,
  { ok: true }
>["value"];

export const FAILURE_MESSAGES: Readonly<Record<ApiFailure, string>> = {
  conflict: "That change conflicts with what Orbis already has.",
  failed: "Orbis could not complete the request. Try again.",
  forbidden: "You cannot do this.",
  limited: "Orbis is busy right now. Try again in a minute.",
  rejected: "Sign in again.",
  // No response at all; on a tailnet device this is often Chrome blocking the
  // call until the Person allows local network access.
  unreachable:
    "Orbis could not be reached. If your browser asks to access devices on your local network, allow it and try again.",
};

const EXPLAINED_STATUSES: ReadonlySet<number> = new Set([
  400, 403, 404, 409, 429,
]);

export const problemFor = (
  result: Extract<ApiResult<unknown>, { ok: false }>
): string =>
  (EXPLAINED_STATUSES.has(result.status ?? 0) ? result.message : undefined) ??
  FAILURE_MESSAGES[result.failure];
