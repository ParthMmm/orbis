import type {
  LibraryFilters,
  LibraryResponse,
  SavedSet,
  SaveSetInput,
  Playlist,
} from "@orbis/contracts";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

export interface OrbisClient {
  list: (filters: LibraryFilters) => Promise<ApiResult<LibraryResponse>>;
  tags: () => Promise<ApiResult<{ tags: string[] }>>;
  playlists: () => Promise<ApiResult<{ playlists: Playlist[] }>>;
  createPlaylist: (name: string) => Promise<ApiResult<Playlist>>;
  setPlaylistMembers: (
    id: string,
    setIds: string[]
  ) => Promise<ApiResult<LibraryResponse>>;
  save: (input: SaveSetInput) => Promise<ApiResult<SavedSet>>;
  updateTags: (id: string, tags: string[]) => Promise<ApiResult<SavedSet>>;
  openSource: (url: string) => Promise<ApiResult<null>>;
}

declare global {
  interface Window {
    orbis: OrbisClient;
  }
}
