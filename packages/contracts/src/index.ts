import type {
  AudioStateSchema,
  FeedBodySchema,
  FeedClientMessageSchema,
  FeedDeliverySchema,
  FeedResetReasonSchema,
  FeedServerMessageSchema,
  FeedTicketSchema,
  HealthResponseSchema,
  LibraryFiltersSchema,
  LibraryResponseSchema,
  ListeningQueueSchema,
  PlaylistSchema,
  PresenceActionPayload,
  PresenceActionResultSchema,
  PresenceConflictSchema,
  PresenceSchema,
  PresenceSessionSchema,
  QueueEntryPayload,
  SaveSetPayload,
  SavedSetSchema,
  TracklistSchema,
  UpdateTitlePayload,
} from "./http-api.js";

export type HealthResponse = typeof HealthResponseSchema.Type;
export type AudioState = typeof AudioStateSchema.Type;
export type SavedSet = typeof SavedSetSchema.Type;
export type Tracklist = typeof TracklistSchema.Type;
export type Cue = Tracklist["cues"][number];
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
export type Presence = typeof PresenceSchema.Type;
export type PresenceAction = typeof PresenceActionPayload.Type;
export type PresenceSession = typeof PresenceSessionSchema.Type;
export type PresenceActionResult = typeof PresenceActionResultSchema.Type;
export type PresenceConflict = typeof PresenceConflictSchema.Type;
export type ListeningQueue = typeof ListeningQueueSchema.Type;
export type FeedBody = typeof FeedBodySchema.Type;
export type FeedDelivery = typeof FeedDeliverySchema.Type;
export type FeedResetReason = typeof FeedResetReasonSchema.Type;
export type FeedServerMessage = typeof FeedServerMessageSchema.Type;
export type FeedClientMessage = typeof FeedClientMessageSchema.Type;
export type FeedTicket = typeof FeedTicketSchema.Type;

/** Where a queued Set goes. `next` starts after the active Set; `end` goes last. */
export type QueuePlacement = (typeof QueueEntryPayload.Type)["placement"];

export {
  normalizeSourceUrl,
  SOURCE_URL_MESSAGE,
  UnsupportedSourceUrlError,
  youTubeVideoId,
} from "./source-url.js";
