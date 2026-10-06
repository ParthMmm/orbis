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
  tracklistState: Schema.Literals(["pending", "ready", "none", "failed"]),
  url: Schema.String,
});
export const CueSchema = Schema.Struct({
  appleMusicId: Schema.NullOr(Schema.String),
  artist: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
  position: Schema.Number,
  startSeconds: Schema.NullOr(Schema.Number),
  title: Schema.String,
});
export const TracklistSchema = Schema.Struct({
  cues: Schema.Array(CueSchema),
  state: SavedSetSchema.fields.tracklistState,
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
const Gone = ErrorBody.pipe(HttpApiSchema.status(410));
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
export const FriendPlaylistSchema = Schema.Struct({
  ...PlaylistSchema.fields,
  sets: Schema.Array(SavedSetSchema),
});
export const ListenSchema = Schema.Struct({
  finishedAt: Schema.NullOr(Schema.String),
  set: SavedSetSchema,
  startedAt: Schema.String,
});
const PlaylistName = Schema.String.check(Schema.isMaxLength(100));
const MembershipId = Schema.String.check(Schema.isMaxLength(100));
export const PlaylistNamePayload = Schema.Struct({ name: PlaylistName });
export const PlaylistMembersPayload = Schema.Struct({
  setIds: Schema.Array(MembershipId).check(
    Schema.isMaxLength(MAX_SETS_PER_PLAYLIST)
  ),
});
export const CollaborationPayload = Schema.Struct({
  collaborative: Schema.Boolean,
});
export const PlaylistEditorsPayload = Schema.Struct({
  editorIds: Schema.Array(MembershipId),
});
export const CollaborationSchema = Schema.Struct({
  collaborative: Schema.Boolean,
  editorIds: Schema.Array(Schema.String),
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
export const PresenceSchema = Schema.Struct({
  personId: Schema.String,
  set: SavedSetSchema,
  username: Schema.String,
});
export const QueueEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queue"), queue: ListeningQueueSchema }),
  Schema.Struct({
    kind: Schema.Literal("presence"),
    presence: Schema.Array(PresenceSchema),
  }),
  Schema.Struct({ kind: Schema.Literal("heartbeat") }),
]);

/** The only feed protocol. A socket upgrade selects it; a ticket names it. */
export const FEED_PROTOCOL = "orbis.feed.v1";
/** A socket upgrade offers the ticket as the subprotocol token `orbis.ticket.<ticket>`. */
export const FEED_TICKET_PROTOCOL_PREFIX = "orbis.ticket.";
export const FEED_SOCKET_PATH = "/events/socket";
/** The exact text a client sends to receive `{"kind":"pong"}` without waking the Group. */
export const FEED_PING = '{"kind":"ping"}';
export const FEED_PONG = '{"kind":"pong"}';
/** A client must acknowledge within this many change messages or be disconnected. */
export const FEED_ACK_WINDOW = 32;
export const FeedCloseCode = {
  /** The key was revoked or its Person removed. */
  closed: 4401,
  /** A message broke the protocol. */
  protocol: 1008,
  /** The client fell a full acknowledgement window behind. */
  slow: 4008,
} as const;

const FeedCursor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(400),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u)
);
export const FeedBodySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queue"), queue: ListeningQueueSchema }),
  Schema.Struct({
    kind: Schema.Literal("presence"),
    presence: Schema.Array(PresenceSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("invalidate"),
    resourceId: Schema.optionalKey(Schema.String),
    topic: Schema.Literals(["library", "playlist", "listen-history", "set"]),
  }),
]);
export const FeedDeliverySchema = Schema.Struct({
  body: FeedBodySchema,
  cursor: FeedCursor,
});
export const FeedResetReasonSchema = Schema.Literals([
  "expired",
  "invalid",
  "access",
]);
/**
 * Every message the client feed sends, over a socket or SSE. `ready` ends a
 * catch-up. `reset` precedes a `snapshot` and tells the client to clear social
 * and invalidated caches. `closing` precedes a server close and names the last
 * acknowledged cursor, when there is one, to resume from.
 */
export const FeedServerMessageSchema = Schema.Union([
  Schema.Struct({
    /** Where to resume after applying every delivery in this message. */
    cursor: FeedCursor,
    deliveries: Schema.Array(FeedDeliverySchema),
    kind: Schema.Literal("changes"),
  }),
  Schema.Struct({
    kind: Schema.Literal("reset"),
    reason: FeedResetReasonSchema,
  }),
  Schema.Struct({
    cursor: FeedCursor,
    kind: Schema.Literal("snapshot"),
    presence: Schema.Array(PresenceSchema),
    queue: ListeningQueueSchema,
  }),
  Schema.Struct({ cursor: FeedCursor, kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("heartbeat") }),
  Schema.Struct({
    cursor: Schema.NullOr(FeedCursor),
    kind: Schema.Literal("closing"),
    reason: Schema.Literals(["slow", "revoked"]),
  }),
  Schema.Struct({ kind: Schema.Literal("pong") }),
]);
/** Socket messages from the client. `hello` comes first and once; `ack` names the last applied cursor. */
export const FeedClientMessageSchema = Schema.Union([
  Schema.Struct({
    cursor: Schema.optionalKey(FeedCursor),
    kind: Schema.Literal("hello"),
  }),
  Schema.Struct({ cursor: FeedCursor, kind: Schema.Literal("ack") }),
  Schema.Struct({ kind: Schema.Literal("ping") }),
]);
export const FeedTicketPayload = Schema.Struct({
  protocol: Schema.Literal(FEED_PROTOCOL),
});
export const FeedTicketSchema = Schema.Struct({
  expiresAt: Schema.String,
  protocol: Schema.Literal(FEED_PROTOCOL),
  ticket: Schema.String,
});
export const FeedLiveQuery = { cursor: Schema.optionalKey(FeedCursor) };

const PresenceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)
);
const Counter = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const ActionFields = {
  actionId: PresenceId,
  actionNumber: Counter,
  sessionId: PresenceId,
};
const OwnedActionFields = { ...ActionFields, ownerGeneration: Counter };
export const PresenceActionPayload = Schema.Union([
  Schema.Struct({
    ...ActionFields,
    kind: Schema.Literal("play"),
    setId: QueueSetId,
  }),
  Schema.Struct({ ...OwnedActionFields, kind: Schema.Literal("pause") }),
  Schema.Struct({ ...OwnedActionFields, kind: Schema.Literal("stop") }),
  Schema.Struct({ ...OwnedActionFields, kind: Schema.Literal("renew") }),
]);
const SessionFields = {
  actionNumber: Counter,
  ownerGeneration: Counter,
  sessionId: Schema.String,
  setId: Schema.String,
};
export const PresenceSessionSchema = Schema.Union([
  Schema.Struct({
    ...SessionFields,
    leaseExpiresAt: Schema.String,
    state: Schema.Literal("playing"),
  }),
  Schema.Struct({
    ...SessionFields,
    state: Schema.Literals(["paused", "stopped", "superseded"]),
  }),
]);
export const PresenceActionResultSchema = Schema.Struct({
  outcome: Schema.Literals(["accepted", "duplicate"]),
  session: PresenceSessionSchema,
});
/** A refused action that changed nothing. `stale` covers a wrong generation or an old action number. */
export const PresenceConflictSchema = Schema.Struct({
  message: Schema.String,
  reason: Schema.Literals([
    "stale",
    "queue-changed",
    "action-reused",
    "session-set",
    "session-limit",
  ]),
}).pipe(HttpApiSchema.status(409));

export const MeSchema = Schema.Struct({
  autoDownload: Schema.Boolean,
  id: Schema.String,
  social: Schema.Boolean,
  username: Schema.String,
});
export const UpdateMePayload = Schema.Struct({
  autoDownload: Schema.optionalKey(Schema.Boolean),
  social: Schema.optionalKey(Schema.Boolean),
  username: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
});
export const SocialFiltersPayload = Schema.Struct({
  appear: Schema.optionalKey(Schema.Boolean),
  see: Schema.optionalKey(Schema.Boolean),
});
const SocialFilters = Schema.Struct({
  appear: Schema.Boolean,
  see: Schema.Boolean,
});
const VisiblePerson = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
});
/** A Collaborative Playlist the caller may edit, with the Person who created it. */
export const SharedPlaylistSchema = Schema.Struct({
  ...PlaylistSchema.fields,
  creator: VisiblePerson,
});
/**
 * One Playlist as its creator or an editor sees it (ADR 0010). `role` says which
 * controls apply: only the creator renames, deletes, or manages editors.
 */
export const PlaylistDetailSchema = Schema.Struct({
  ...SharedPlaylistSchema.fields,
  role: Schema.Literals(["creator", "editor"]),
  sets: Schema.Array(SavedSetSchema),
});
/**
 * A Person the caller would see if their own See filter allowed it, with the
 * caller's See and Appear filters for them (ADR 0009).
 */
export const PersonFiltersSchema = Schema.Struct({
  ...VisiblePerson.fields,
  ...SocialFilters.fields,
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
  scope: Schema.Literals(["daily", "admin", "node"]),
});

export const DeviceSchema = Schema.Struct({
  addedAt: Schema.String,
  current: Schema.Boolean,
  id: Schema.String,
  label: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});
/** A Device Link (ADR 0016): a new device's code, approved from a signed-in one. */
export const DeviceLinkStartPayload = Schema.Struct({
  label: Schema.String.check(Schema.isMaxLength(100)),
});
export const DeviceLinkStartSchema = Schema.Struct({
  expiresAt: Schema.String,
  pollSecret: Schema.String,
  userCode: Schema.String,
});
export const DeviceLinkCodePayload = Schema.Struct({
  userCode: Schema.String.check(Schema.isMaxLength(20)),
});
export const DeviceLinkSchema = Schema.Struct({
  expiresAt: Schema.String,
  label: Schema.String,
});
export const DeviceLinkPollPayload = Schema.Struct({
  pollSecret: Schema.String.check(Schema.isMaxLength(200)),
});
/** An Invite (ADR 0016): a one-time code the Host sends, claimed for a daily key. */
export const InviteSchema = Schema.Struct({
  code: Schema.String,
  expiresAt: Schema.String,
});
export const InviteClaimPayload = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(200)),
  label: Schema.String.check(Schema.isMaxLength(100)),
});
export const InviteClaimSchema = Schema.Struct({
  key: Schema.String,
  person: VisiblePerson,
});
export const DeviceLinkPollSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({
    key: Schema.String,
    person: VisiblePerson,
    status: Schema.Literal("approved"),
  }),
]);

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
      HttpApiEndpoint.get("tracklist", "/sets/:id/tracklist", {
        error: [NotFound, InternalError],
        params: SetId,
        success: TracklistSchema,
      }),
      HttpApiEndpoint.post("retryTracklist", "/sets/:id/tracklist/retry", {
        error: [NotFound, InternalError],
        params: SetId,
        success: TracklistSchema,
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
      HttpApiEndpoint.get("shared", "/playlists/shared", {
        error: InternalError,
        success: Schema.Struct({
          playlists: Schema.Array(SharedPlaylistSchema),
        }),
      }),
      HttpApiEndpoint.get("read", "/playlists/:id", {
        error: [NotFound, InternalError],
        params: SetId,
        success: PlaylistDetailSchema,
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
      HttpApiEndpoint.get("collaboration", "/playlists/:id/collaboration", {
        error: [NotFound, InternalError],
        params: SetId,
        success: CollaborationSchema,
      }),
      HttpApiEndpoint.put("setCollaboration", "/playlists/:id/collaboration", {
        error: [BadRequest, NotFound, InternalError],
        params: SetId,
        payload: CollaborationPayload,
        success: CollaborationSchema,
      }),
      HttpApiEndpoint.put("setEditors", "/playlists/:id/editors", {
        error: [BadRequest, NotFound, InternalError],
        params: SetId,
        payload: PlaylistEditorsPayload,
        success: CollaborationSchema,
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
        }),
        HttpApiEndpoint.get("list", "/people", {
          success: Schema.Struct({ people: Schema.Array(VisiblePerson) }),
        }),
        HttpApiEndpoint.get("socialFilters", "/people/filters", {
          error: InternalError,
          success: Schema.Struct({ people: Schema.Array(PersonFiltersSchema) }),
        }),
        HttpApiEndpoint.put("filters", "/people/:id/filters", {
          error: [BadRequest, NotFound, InternalError],
          params: SetId,
          payload: SocialFiltersPayload,
          success: SocialFilters,
        }),
        HttpApiEndpoint.get("sets", "/people/:id/sets", {
          error: [NotFound, InternalError],
          params: SetId,
          success: LibraryResponseSchema,
        }),
        HttpApiEndpoint.get("friendPlaylists", "/people/:id/playlists", {
          error: [NotFound, InternalError],
          params: SetId,
          success: Schema.Struct({
            playlists: Schema.Array(FriendPlaylistSchema),
          }),
        }),
        HttpApiEndpoint.get("friendListens", "/people/:id/listens", {
          error: [NotFound, InternalError],
          params: SetId,
          success: Schema.Struct({ listens: Schema.Array(ListenSchema) }),
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
        }),
        HttpApiEndpoint.post("createInvite", "/admin/people/:id/invites", {
          error: [NotFound, InternalError],
          params: SetId,
          success: InviteSchema.pipe(HttpApiSchema.status(201)),
        })
      )
      .middleware(SetAccess)
  )
  .add(
    // Claim carries no key; the new device has none yet.
    HttpApiGroup.make("invites").add(
      HttpApiEndpoint.post("claim", "/invites/claim", {
        error: [
          BadRequest,
          NotFound,
          Conflict,
          Gone,
          TooManyRequests,
          InternalError,
        ],
        payload: InviteClaimPayload,
        success: InviteClaimSchema,
      })
    )
  )
  .add(
    HttpApiGroup.make("devices")
      .add(
        HttpApiEndpoint.get("list", "/me/devices", {
          error: InternalError,
          success: Schema.Struct({ devices: Schema.Array(DeviceSchema) }),
        }),
        HttpApiEndpoint.delete("revoke", "/me/devices/:id", {
          error: [NotFound, InternalError],
          params: SetId,
          success: DeviceSchema,
        })
      )
      .middleware(SetAccess)
  )
  .add(
    // Start and poll carry no key; the new device has none yet. Lookup and
    // approve run as the signed-in Person who approves the device.
    HttpApiGroup.make("deviceLinks").add(
      HttpApiEndpoint.post("start", "/device-links", {
        error: [BadRequest, TooManyRequests, ServiceUnavailable],
        payload: DeviceLinkStartPayload,
        success: DeviceLinkStartSchema.pipe(HttpApiSchema.status(201)),
      }),
      HttpApiEndpoint.post("poll", "/device-links/poll", {
        error: [BadRequest, NotFound, TooManyRequests, InternalError],
        payload: DeviceLinkPollPayload,
        success: DeviceLinkPollSchema,
      }),
      HttpApiEndpoint.post("lookup", "/device-links/lookup", {
        error: [BadRequest, NotFound, Conflict, Gone],
        payload: DeviceLinkCodePayload,
        success: DeviceLinkSchema,
      }).middleware(SetAccess),
      HttpApiEndpoint.post("approve", "/device-links/approve", {
        error: [BadRequest, NotFound, Conflict, Gone],
        payload: DeviceLinkCodePayload,
        success: DeviceLinkSchema,
      }).middleware(SetAccess)
    )
  )
  .add(
    HttpApiGroup.make("events")
      .add(
        HttpApiEndpoint.get("subscribe", "/events", {
          success: HttpApiSchema.StreamSse({
            data: QueueEventSchema,
            error: Schema.Never,
          }),
        }),
        HttpApiEndpoint.post("ticket", "/events/tickets", {
          error: [BadRequest, Forbidden, InternalError],
          payload: FeedTicketPayload,
          success: FeedTicketSchema.pipe(HttpApiSchema.status(201)),
        }),
        HttpApiEndpoint.get("live", "/events/live", {
          error: [BadRequest, Forbidden],
          query: FeedLiveQuery,
          success: HttpApiSchema.StreamSse({
            data: FeedServerMessageSchema,
            error: Schema.Never,
          }),
        })
      )
      .middleware(SetAccess)
  )
  .add(
    HttpApiGroup.make("presence")
      .add(
        HttpApiEndpoint.post("act", "/presence/actions", {
          error: [
            BadRequest,
            Forbidden,
            NotFound,
            PresenceConflictSchema,
            InternalError,
          ],
          payload: PresenceActionPayload,
          success: PresenceActionResultSchema,
        })
      )
      .middleware(SetAccess)
  );
