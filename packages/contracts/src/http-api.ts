import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

import type { SetCaller } from "./set-caller.js";

export { SetCaller } from "./set-caller.js";

const ErrorBody = Schema.Struct({ message: Schema.String });
const Unauthorized = ErrorBody.pipe(HttpApiSchema.status(401));
const Forbidden = ErrorBody.pipe(HttpApiSchema.status(403));

export class SetAccess extends HttpApiMiddleware.Service<
  SetAccess,
  { provides: typeof SetCaller }
>()("Orbis/SetAccess", {
  error: [Unauthorized, Forbidden],
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export const SavedSetSchema = Schema.Struct({
  artworkLargeUrl: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  creator: Schema.NullOr(Schema.String),
  creatorId: Schema.NullOr(Schema.String),
  downloadState: Schema.Literals([
    "none",
    "queued",
    "downloading",
    "ready",
    "failed",
    "canceled",
  ]),
  durationSeconds: Schema.NullOr(Schema.Number),
  finishCount: Schema.Number,
  id: Schema.String,
  lastListenedAt: Schema.NullOr(Schema.String),
  listenCount: Schema.Number,
  metadataState: Schema.Literals(["pending", "enriched", "failed"]),
  playbackPositionSeconds: Schema.Number,
  playlistIds: Schema.Array(Schema.String).pipe(Schema.mutable),
  releasedAt: Schema.NullOr(Schema.String),
  retainedAudioBytes: Schema.NullOr(Schema.Number),
  retainedAudioFormat: Schema.NullOr(Schema.String),
  source: Schema.Literals(["youtube", "soundcloud"]),
  tags: Schema.Array(Schema.String).pipe(Schema.mutable),
  title: Schema.String,
  titleEditedByUser: Schema.Boolean,
  url: Schema.String,
});
export const LibraryResponseSchema = Schema.Struct({
  sets: Schema.Array(SavedSetSchema).pipe(Schema.mutable),
});
export const HealthResponseSchema = Schema.Struct({
  status: Schema.Literal("ok"),
});
export const LibraryFiltersSchema = Schema.Struct({
  creatorId: Schema.optionalKey(Schema.String),
  playlistId: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["youtube", "soundcloud"])),
  tags: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.mutable)),
});

const SetId = { id: Schema.String };
const BadRequest = ErrorBody.pipe(HttpApiSchema.status(400));
const NotFound = ErrorBody.pipe(HttpApiSchema.status(404));
const Conflict = ErrorBody.pipe(HttpApiSchema.status(409));
const RangeNotSatisfiable = Schema.Void.pipe(HttpApiSchema.status(416));
const InternalError = ErrorBody.pipe(HttpApiSchema.status(500));
const TooManyRequests = ErrorBody.pipe(HttpApiSchema.status(429));
const ServiceUnavailable = ErrorBody.pipe(HttpApiSchema.status(503));
const SearchValue = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const Tags = Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
  Schema.isMaxLength(20)
);
const Title = Schema.String.check(Schema.isMaxLength(200));
export const SaveSetPayload = Schema.Struct({
  tags: Schema.optionalKey(Tags),
  title: Schema.optionalKey(Title),
  url: Schema.String.check(Schema.isMaxLength(2048)),
});
export const UpdateTitlePayload = Schema.Struct({ title: Title });
export const AudioStateSchema = Schema.Struct({
  bytesReceived: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  format: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "none",
    "queued",
    "downloading",
    "ready",
    "failed",
    "canceled",
  ]),
});

export const MAX_SETS_PER_PLAYLIST = 500;
export const MAX_PLAYLISTS_PER_SET = 100;

export const PlaylistSchema = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
  setCount: Schema.Number,
});
const PlaylistName = Schema.String.check(Schema.isMaxLength(100));
const MembershipId = Schema.String.check(Schema.isMaxLength(100));
export const PlaylistNamePayload = Schema.Struct({ name: PlaylistName });
export const PlaylistMembersPayload = Schema.Struct({
  setIds: Schema.Array(MembershipId).check(
    Schema.isMaxLength(MAX_SETS_PER_PLAYLIST)
  ),
});
export const SetPlaylistsPayload = Schema.Struct({
  playlistIds: Schema.Array(MembershipId).check(
    Schema.isMaxLength(MAX_PLAYLISTS_PER_SET)
  ),
});

export const ListeningQueueSchema = Schema.Struct({
  activeSetId: Schema.NullOr(Schema.String),
  entries: Schema.Array(SavedSetSchema).pipe(Schema.mutable),
});
const QueueResponse = Schema.Struct({ queue: ListeningQueueSchema });
const QueueSetId = Schema.String.check(Schema.isMaxLength(100));
export const QueueSetPayload = Schema.Struct({ setId: QueueSetId });
export const QueueEntryPayload = Schema.Struct({
  placement: Schema.Literals(["next", "end"]),
  setId: QueueSetId,
});
export const QueuePlaylistPayload = Schema.Struct({ playlistId: QueueSetId });
export const PositionPayload = Schema.Struct({
  seconds: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(604_800)
  ),
});
export const TagsPayload = Schema.Struct({ tags: Tags });
export const MeSchema = Schema.Struct({
  autoDownload: Schema.Boolean,
  id: Schema.String,
  username: Schema.String,
});
export const UpdateMePayload = Schema.Struct({
  autoDownload: Schema.optionalKey(Schema.Boolean),
  username: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
});

export const SaveSetResultSchema = Schema.Struct({
  ...SavedSetSchema.fields,
  autoDownloadResult: Schema.Literals([
    "queued",
    "disabled",
    "ready",
    "inProgress",
    "queueFull",
    "unavailable",
  ]),
});
export const AdminPersonPayload = Schema.Struct({
  username: Schema.String.check(Schema.isMaxLength(40)),
});
export const AdminKeyPayload = Schema.Struct({
  label: Schema.String.check(Schema.isMaxLength(100)),
  scope: Schema.optionalKey(Schema.Literals(["daily", "admin"])),
});
const AdminPerson = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
});
const AdminKey = Schema.Struct({
  addedAt: Schema.String,
  id: Schema.String,
  label: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  personId: Schema.String,
  scope: Schema.Literals(["daily", "admin"]),
});

export const SetsApi = HttpApi.make("orbis").add(
  HttpApiGroup.make("sets")
    .add(
      HttpApiEndpoint.post("save", "/sets", {
        error: [BadRequest, Conflict, InternalError],
        payload: SaveSetPayload,
        success: SaveSetResultSchema.pipe(HttpApiSchema.status(201)),
      }),
      HttpApiEndpoint.get("list", "/sets", {
        error: [BadRequest, InternalError],
        query: {
          creatorId: Schema.optionalKey(SearchValue),
          playlistId: Schema.optionalKey(SearchValue),
          q: Schema.optionalKey(SearchValue),
          source: Schema.optionalKey(SearchValue),
          tag: Schema.optionalKey(Schema.Array(Schema.String)),
        },
        success: LibraryResponseSchema,
      }),
      HttpApiEndpoint.post("retryMetadata", "/sets/:id/metadata", {
        error: [NotFound, InternalError],
        params: SetId,
        success: SavedSetSchema,
      }),
      HttpApiEndpoint.patch("updateTitle", "/sets/:id/title", {
        error: [BadRequest, NotFound, InternalError],
        params: SetId,
        payload: UpdateTitlePayload,
        success: SavedSetSchema,
      }),
      HttpApiEndpoint.delete("remove", "/sets/:id", {
        error: [NotFound, InternalError],
        params: SetId,
        success: SavedSetSchema,
      }),
      HttpApiEndpoint.post("requestDownload", "/sets/:id/audio/download", {
        error: [
          NotFound,
          Conflict,
          TooManyRequests,
          InternalError,
          ServiceUnavailable,
        ],
        params: SetId,
        success: [
          SavedSetSchema,
          SavedSetSchema.pipe(HttpApiSchema.status(202)),
        ],
      }),
      HttpApiEndpoint.delete("cancelDownload", "/sets/:id/audio/download", {
        error: [BadRequest, NotFound, Conflict, InternalError],
        params: SetId,
        success: SavedSetSchema,
      }),
      HttpApiEndpoint.get("audioState", "/sets/:id/audio/state", {
        error: [NotFound, InternalError],
        params: SetId,
        success: AudioStateSchema,
      }),
      HttpApiEndpoint.post("audioGrant", "/sets/:id/audio/grant", {
        error: [NotFound, InternalError],
        params: SetId,
        success: Schema.Struct({ url: Schema.String }),
      }),
      HttpApiEndpoint.get("audio", "/sets/:id/audio", {
        error: [NotFound, RangeNotSatisfiable, InternalError],
        params: SetId,
        success: [
          HttpApiSchema.status(200)(HttpApiSchema.StreamUint8Array()),
          Schema.Uint8Array.pipe(
            HttpApiSchema.asUint8Array(),
            HttpApiSchema.status(206)
          ),
        ],
      })
    )
    .middleware(SetAccess)
);

const PlaylistApi = SetsApi.add(
  HttpApiGroup.make("playlists")
    .add(
      HttpApiEndpoint.get("list", "/playlists", {
        error: InternalError,
        success: Schema.Struct({ playlists: Schema.Array(PlaylistSchema) }),
      }),
      HttpApiEndpoint.post("create", "/playlists", {
        error: [BadRequest, Conflict, InternalError],
        payload: PlaylistNamePayload,
        success: PlaylistSchema.pipe(HttpApiSchema.status(201)),
      }),
      HttpApiEndpoint.patch("rename", "/playlists/:id", {
        error: [BadRequest, NotFound, Conflict, InternalError],
        params: SetId,
        payload: PlaylistNamePayload,
        success: PlaylistSchema,
      }),
      HttpApiEndpoint.delete("remove", "/playlists/:id", {
        error: [NotFound, InternalError],
        params: SetId,
        success: PlaylistSchema,
      }),
      HttpApiEndpoint.put("replaceMembers", "/playlists/:id/sets", {
        error: [BadRequest, NotFound, InternalError],
        params: SetId,
        payload: PlaylistMembersPayload,
        success: LibraryResponseSchema,
      }),
      HttpApiEndpoint.put("replaceSetPlaylists", "/sets/:id/playlists", {
        error: [BadRequest, NotFound, InternalError],
        params: SetId,
        payload: SetPlaylistsPayload,
        success: SavedSetSchema,
      })
    )
    .middleware(SetAccess)
);

export const OrbisApi = PlaylistApi.add(
  HttpApiGroup.make("queue")
    .add(
      HttpApiEndpoint.get("read", "/queue", {
        error: InternalError,
        success: QueueResponse,
      }),
      HttpApiEndpoint.put("play", "/queue/active", {
        error: [BadRequest, NotFound, InternalError],
        payload: QueueSetPayload,
        success: QueueResponse,
      }),
      HttpApiEndpoint.post("insert", "/queue/entries", {
        error: [BadRequest, NotFound, InternalError],
        payload: QueueEntryPayload,
        success: QueueResponse.pipe(HttpApiSchema.status(201)),
      }),
      HttpApiEndpoint.put("replaceWithPlaylist", "/queue/playlist", {
        error: [BadRequest, NotFound, InternalError],
        payload: QueuePlaylistPayload,
        success: QueueResponse,
      }),
      HttpApiEndpoint.post("complete", "/queue/completion", {
        error: [BadRequest, NotFound, InternalError],
        payload: QueueSetPayload,
        success: QueueResponse,
      })
    )
    .middleware(SetAccess)
)
  .add(
    HttpApiGroup.make("library")
      .add(
        HttpApiEndpoint.put("setPosition", "/sets/:id/position", {
          error: [BadRequest, NotFound, InternalError],
          params: SetId,
          payload: PositionPayload,
          success: SavedSetSchema,
        }),
        HttpApiEndpoint.get("tags", "/tags", {
          error: InternalError,
          success: Schema.Struct({ tags: Schema.Array(Schema.String) }),
        }),
        HttpApiEndpoint.patch("updateTags", "/sets/:id/tags", {
          error: [BadRequest, NotFound, InternalError],
          params: SetId,
          payload: TagsPayload,
          success: SavedSetSchema,
        })
      )
      .middleware(SetAccess)
  )
  .add(
    HttpApiGroup.make("people")
      .add(
        HttpApiEndpoint.get("me", "/me", { success: MeSchema }),
        HttpApiEndpoint.patch("updateMe", "/me", {
          error: [BadRequest, Conflict, InternalError],
          payload: UpdateMePayload,
          success: MeSchema,
        })
      )
      .middleware(SetAccess)
  )
  .add(
    HttpApiGroup.make("system").add(
      HttpApiEndpoint.get("health", "/health", {
        success: HealthResponseSchema,
      })
    )
  )
  .add(
    HttpApiGroup.make("admin")
      .add(
        HttpApiEndpoint.get("people", "/admin/people", {
          success: Schema.Struct({ people: Schema.Array(AdminPerson) }),
        }),
        HttpApiEndpoint.post("addPerson", "/admin/people", {
          error: [BadRequest, Conflict, InternalError],
          payload: AdminPersonPayload,
          success: AdminPerson.pipe(HttpApiSchema.status(201)),
        }),
        HttpApiEndpoint.delete("removePerson", "/admin/people/:id", {
          error: [BadRequest, NotFound, InternalError],
          params: SetId,
          success: AdminPerson,
        }),
        HttpApiEndpoint.get("keys", "/admin/keys", {
          success: Schema.Struct({ keys: Schema.Array(AdminKey) }),
        }),
        HttpApiEndpoint.get("personKeys", "/admin/people/:id/keys", {
          error: NotFound,
          params: SetId,
          success: Schema.Struct({ keys: Schema.Array(AdminKey) }),
        }),
        HttpApiEndpoint.post("addKey", "/admin/people/:id/keys", {
          error: [BadRequest, NotFound, InternalError],
          params: SetId,
          payload: AdminKeyPayload,
          success: Schema.Struct({
            ...AdminKey.fields,
            token: Schema.String,
          }).pipe(HttpApiSchema.status(201)),
        }),
        HttpApiEndpoint.delete("revokeKey", "/admin/keys/:id", {
          error: [NotFound, InternalError],
          params: SetId,
          success: AdminKey,
        })
      )
      .middleware(SetAccess)
  );
