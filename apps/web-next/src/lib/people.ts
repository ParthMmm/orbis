import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** Turns the Person's Social switch on or off (ADR 0009). */
export const setSocial = (credentials: Credentials, social: boolean) =>
  callOrbis(credentials, (client) =>
    client.people.updateMe({ payload: { social } })
  );

/** The People the caller could see, with the caller's See and Appear for each. */
export const listPeopleFilters = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.people.socialFilters());

/** The People who pass the social gate now. */
export const listVisiblePeople = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.people.list());

export const setFilter = (
  credentials: Credentials,
  id: string,
  filter: { readonly see: boolean } | { readonly appear: boolean }
) =>
  callOrbis(credentials, (client) =>
    client.people.filters({ params: { id }, payload: filter })
  );

export const friendSets = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.people.sets({ params: { id } }));

export const friendPlaylists = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.people.friendPlaylists({ params: { id } })
  );

export const friendListens = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.people.friendListens({ params: { id } })
  );

export type PersonFilters = Extract<
  Awaited<ReturnType<typeof listPeopleFilters>>,
  { ok: true }
>["value"]["people"][number];

export type FriendPlaylist = Extract<
  Awaited<ReturnType<typeof friendPlaylists>>,
  { ok: true }
>["value"]["playlists"][number];

export type Listen = Extract<
  Awaited<ReturnType<typeof friendListens>>,
  { ok: true }
>["value"]["listens"][number];
