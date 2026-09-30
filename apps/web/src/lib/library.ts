import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** The Library filters, as the URL carries them. */
export interface LibraryFilters {
  readonly q?: string;
  readonly source?: "youtube" | "soundcloud";
  readonly tag?: string;
}

/** The query `GET /sets` accepts. */
interface SetsQuery {
  q?: string;
  source?: string;
  tag?: string[];
}

export const listSets = (credentials: Credentials, filters: LibraryFilters) => {
  const query: SetsQuery = {};
  if (filters.q !== undefined) {
    query.q = filters.q;
  }
  if (filters.source !== undefined) {
    query.source = filters.source;
  }
  if (filters.tag !== undefined) {
    query.tag = [filters.tag];
  }
  return callOrbis(credentials, (client) => client.sets.list({ query }));
};

export const listTags = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.library.tags());

export const saveSet = (credentials: Credentials, url: string) =>
  callOrbis(credentials, (client) => client.sets.save({ payload: { url } }));

export const renameSet = (
  credentials: Credentials,
  id: string,
  title: string
) =>
  callOrbis(credentials, (client) =>
    client.sets.updateTitle({ params: { id }, payload: { title } })
  );

export const updateTags = (
  credentials: Credentials,
  id: string,
  tags: readonly string[]
) =>
  callOrbis(credentials, (client) =>
    client.library.updateTags({ params: { id }, payload: { tags: [...tags] } })
  );

export const removeSet = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.sets.remove({ params: { id } }));

export const requestDownload = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.sets.requestDownload({ params: { id } })
  );

export const cancelDownload = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.sets.cancelDownload({ params: { id } })
  );

export const audioState = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.sets.audioState({ params: { id } })
  );

export type SavedSet = Extract<
  Awaited<ReturnType<typeof listSets>>,
  { ok: true }
>["value"]["sets"][number];

export type AutoDownloadResult = Extract<
  Awaited<ReturnType<typeof saveSet>>,
  { ok: true }
>["value"]["autoDownloadResult"];
