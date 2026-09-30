import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

export const getTracklist = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.sets.tracklist({ params: { id } }));

export const retryTracklist = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.sets.retryTracklist({ params: { id } })
  );
