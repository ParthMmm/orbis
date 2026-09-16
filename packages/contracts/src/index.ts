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
  /** The provider's image, sized for a listing row. */
  artworkUrl: string | null;
  /**
   * The same image at the largest size the provider offers, which only a Set's own page draws.
   * Null when the provider offers nothing larger, and absent from a service that predates it.
   */
  artworkLargeUrl: string | null;
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

/**
 * The one Listening Queue. Entries are in play order, and at most one of them is the active
 * Set: the Set whose Listen is open and whose Playback Position is being kept.
 */
export interface ListeningQueue {
  activeSetId: string | null;
  entries: SavedSet[];
}

/** Where a queued Set goes. `next` starts after the active Set; `end` goes last. */
export type QueuePlacement = "next" | "end";

export {
  normalizeSourceUrl,
  SOURCE_URL_MESSAGE,
  UnsupportedSourceUrlError,
  youTubeVideoId,
} from "./source-url.js";
