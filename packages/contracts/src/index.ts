export interface HealthResponse {
  readonly status: "ok";
}

export type SetSource = "youtube" | "soundcloud";

export interface SavedSet {
  id: string;
  url: string;
  title: string;
  source: SetSource;
  tags: string[];
  createdAt: string;
}

export interface SaveSetInput {
  url: string;
  title: string;
  tags: string[];
}

export interface UpdateSetTitleInput {
  title: string;
}

export interface LibraryFilters {
  playlistId?: string;
  q?: string;
  source?: SetSource;
  tags?: string[];
}

export interface LibraryResponse {
  sets: SavedSet[];
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: string;
}
