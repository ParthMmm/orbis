import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

import type { AudioState, Playlist, SavedSet } from "./index.js";
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

const SetId = { id: Schema.String };
const BadRequest = ErrorBody.pipe(HttpApiSchema.status(400));
const NotFound = ErrorBody.pipe(HttpApiSchema.status(404));
const Conflict = ErrorBody.pipe(HttpApiSchema.status(409));
const RangeNotSatisfiable = Schema.Void.pipe(HttpApiSchema.status(416));
const InternalError = ErrorBody.pipe(HttpApiSchema.status(500));
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

type Assert<T extends true> = T;
type SameContract<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
export type SavedSetContractCheck = Assert<
  SameContract<typeof SavedSetSchema.Type, SavedSet>
>;
export type AudioStateContractCheck = Assert<
  SameContract<typeof AudioStateSchema.Type, AudioState>
>;

export const MAX_SETS_PER_PLAYLIST = 500;
export const MAX_PLAYLISTS_PER_SET = 100;

export const PlaylistSchema = Schema.Struct({
  createdAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
  setCount: Schema.Number,
});
export type PlaylistContractCheck = Assert<
  SameContract<typeof PlaylistSchema.Type, Playlist>
>;

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

export const SetsApi = HttpApi.make("orbis").add(
  HttpApiGroup.make("sets")
    .add(
      HttpApiEndpoint.post("save", "/sets", {
        error: [BadRequest, Conflict, InternalError],
        payload: SaveSetPayload,
        success: SavedSetSchema.pipe(HttpApiSchema.status(201)),
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
        success: Schema.Struct({ sets: Schema.Array(SavedSetSchema) }),
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
        error: [NotFound, Conflict, InternalError, ServiceUnavailable],
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

export const OrbisApi = SetsApi.add(
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
        success: Schema.Struct({ sets: Schema.Array(SavedSetSchema) }),
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
