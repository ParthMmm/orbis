export interface HealthResponse {
  readonly status: "ok";
}

export type SetSource = "youtube" | "soundcloud";

export type MetadataState = "pending" | "enriched" | "failed";

export type DownloadState =
  | "none"
  | "queued"
  | "downloading"
  | "ready"
  | "failed"
  | "canceled";

export interface AudioState {
  state: DownloadState;
  bytesReceived: number;
  bytesTotal: number | null;
  format: string | null;
}

export interface SavedSet {
  id: string;
  url: string;
  title: string;
  source: SetSource;
  tags: string[];
  createdAt: string;
  creator: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  metadataState: MetadataState;
  titleEditedByUser: boolean;
  playlistIds: string[];
  downloadState: DownloadState;
  retainedAudioBytes: number | null;
  retainedAudioFormat: string | null;
  playbackPositionSeconds: number;
  listenCount: number;
  finishCount: number;
  lastListenedAt: string | null;
}

export interface SaveSetInput {
  url: string;
  /** Absent or blank asks the server to take the title from the source metadata. */
  title?: string;
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
  /** How many Sets the playlist holds, so a sidebar can show the number without a request each. */
  setCount: number;
}

export {
  normalizeSourceUrl,
  SOURCE_URL_MESSAGE,
  UnsupportedSourceUrlError,
  youTubeVideoId,
} from "./source-url.js";
