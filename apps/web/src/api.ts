import { OrbisApi } from "@orbis/contracts/http-api";
import { Effect } from "effect";
import type { Effect as EffectType, Success } from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export class ApiFailureError extends Error {
  readonly status: number | undefined;

  constructor(status: number | undefined) {
    super(
      status === 401
        ? "The API key is no longer valid."
        : "Orbis could not complete the request."
    );
    this.name = "ApiFailureError";
    this.status = status;
  }
}

const makeOrbisClient = (key: string) =>
  HttpApiClient.make(OrbisApi, {
    baseUrl: `${window.location.origin}/api`,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("authorization", `Bearer ${key}`)
    ),
  });
type OrbisClient = Success<ReturnType<typeof makeOrbisClient>>;

const call = <A, E>(
  key: string,
  operation: (client: OrbisClient) => EffectType<A, E>
): Promise<A> => {
  let status: number | undefined;
  const trackedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    ({ status } = response);
    return response;
  };
  return Effect.runPromise(
    Effect.gen(function* request() {
      const client = yield* makeOrbisClient(key);
      return yield* operation(client);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, trackedFetch)
    )
  ).catch(() => {
    throw new ApiFailureError(status);
  });
};

export const api = (key: string) => ({
  complete: (setId: string) =>
    call(key, (client) => client.queue.complete({ payload: { setId } })),
  grant: (id: string) =>
    call(key, (client) => client.sets.audioGrant({ params: { id } })),
  list: (query: {
    q?: string;
    source?: "youtube" | "soundcloud";
    tag?: string[];
  }) => call(key, (client) => client.sets.list({ query })),
  me: () => call(key, (client) => client.people.me()),
  play: (setId: string) =>
    call(key, (client) => client.queue.play({ payload: { setId } })),
  position: (id: string, seconds: number) =>
    call(key, (client) =>
      client.library.setPosition({ params: { id }, payload: { seconds } })
    ),
  tags: () => call(key, (client) => client.library.tags()),
});

export const streamUrl = (setId: string, granted: string): string => {
  const url = new URL(granted, window.location.origin);
  if (
    url.origin !== window.location.origin ||
    url.pathname !== `/sets/${encodeURIComponent(setId)}/audio`
  ) {
    throw new Error("Orbis returned an invalid audio grant.");
  }
  return `${window.location.origin}/api${url.pathname}${url.search}`;
};
