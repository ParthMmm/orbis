import type {
  AudioStateSchema,
  HealthResponseSchema,
  LibraryFiltersSchema,
  LibraryResponseSchema,
  ListeningQueueSchema,
  PlaylistSchema,
  QueueEntryPayload,
  SaveSetPayload,
  SavedSetSchema,
  UpdateTitlePayload,
} from "./http-api.js";

export type HealthResponse = typeof HealthResponseSchema.Type;
export type AudioState = typeof AudioStateSchema.Type;
export type SavedSet = typeof SavedSetSchema.Type;
export type SetSource = SavedSet["source"];
export type MetadataState = SavedSet["metadataState"];
export type DownloadState = SavedSet["downloadState"];

export type SaveSetInput = Omit<typeof SaveSetPayload.Type, "tags"> & {
  tags: string[];
};

export type UpdateSetTitleInput = typeof UpdateTitlePayload.Type;

export type LibraryFilters = {
  -readonly [
    Key in keyof typeof LibraryFiltersSchema.Type
  ]: (typeof LibraryFiltersSchema.Type)[Key];
};

export type LibraryResponse = typeof LibraryResponseSchema.Type;

export type Playlist = typeof PlaylistSchema.Type;
export type ListeningQueue = typeof ListeningQueueSchema.Type;

/** Where a queued Set goes. `next` starts after the active Set; `end` goes last. */
export type QueuePlacement = (typeof QueueEntryPayload.Type)["placement"];

export {
  normalizeSourceUrl,
  SOURCE_URL_MESSAGE,
  UnsupportedSourceUrlError,
  youTubeVideoId,
} from "./source-url.js";
