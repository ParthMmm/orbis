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
  audioState: (id: string) =>
    call(key, (client) => client.sets.audioState({ params: { id } })),
  complete: (setId: string) =>
    call(key, (client) => client.queue.complete({ payload: { setId } })),
  createPlaylist: (name: string) =>
    call(key, (client) => client.playlists.create({ payload: { name } })),
  deletePlaylist: (id: string) =>
    call(key, (client) => client.playlists.remove({ params: { id } })),
  download: (id: string) =>
    call(key, (client) => client.sets.requestDownload({ params: { id } })),
  friendSets: (id: string) =>
    call(key, (client) => client.people.sets({ params: { id } })),
  grant: (id: string) =>
    call(key, (client) => client.sets.audioGrant({ params: { id } })),
  list: (query: {
    playlistId?: string;
    q?: string;
    source?: "youtube" | "soundcloud";
    tag?: string[];
  }) => call(key, (client) => client.sets.list({ query })),
  me: () => call(key, (client) => client.people.me()),
  people: () => call(key, (client) => client.people.list()),
  play: (setId: string) =>
    call(key, (client) => client.queue.play({ payload: { setId } })),
  playPlaylist: (playlistId: string) =>
    call(key, (client) =>
      client.queue.replaceWithPlaylist({ payload: { playlistId } })
    ),
  playlistMembers: (id: string) =>
    call(key, (client) => client.sets.list({ query: { playlistId: id } })),
  playlists: () => call(key, (client) => client.playlists.list()),
  position: (id: string, seconds: number) =>
    call(key, (client) =>
      client.library.setPosition({ params: { id }, payload: { seconds } })
    ),
  queue: () => call(key, (client) => client.queue.read()),
  queueInsert: (setId: string, placement: "next" | "end") =>
    call(key, (client) =>
      client.queue.insert({ payload: { placement, setId } })
    ),
  renamePlaylist: (id: string, name: string) =>
    call(key, (client) =>
      client.playlists.rename({ params: { id }, payload: { name } })
    ),
  replaceMembers: (id: string, setIds: string[]) =>
    call(key, (client) =>
      client.playlists.replaceMembers({ params: { id }, payload: { setIds } })
    ),
  save: (url: string) =>
    call(key, (client) => client.sets.save({ payload: { url } })),
  tags: () => call(key, (client) => client.library.tags()),
  updateAutoDownload: (autoDownload: boolean) =>
    call(key, (client) =>
      client.people.updateMe({ payload: { autoDownload } })
    ),
  updateMe: (social: boolean) =>
    call(key, (client) => client.people.updateMe({ payload: { social } })),
});

export const adminApi = (key: string) => ({
  addKey: (personId: string, label: string) =>
    call(key, (client) =>
      client.admin.addKey({ params: { id: personId }, payload: { label } })
    ),
  addPerson: (username: string) =>
    call(key, (client) => client.admin.addPerson({ payload: { username } })),
  keys: (personId: string) =>
    call(key, (client) =>
      client.admin.personKeys({ params: { id: personId } })
    ),
  people: () => call(key, (client) => client.admin.people()),
  removePerson: (id: string) =>
    call(key, (client) => client.admin.removePerson({ params: { id } })),
  revokeKey: (id: string) =>
    call(key, (client) => client.admin.revokeKey({ params: { id } })),
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
