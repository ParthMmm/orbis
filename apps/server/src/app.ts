import path from "node:path";

import type { SavedSet } from "@orbis/contracts";
import type { SaveSetResultSchema } from "@orbis/contracts/http-api";
import {
  AdminKeyPayload,
  AdminPersonPayload,
  SaveSetPayload,
  OrbisApi,
  PlaylistMembersPayload,
  PlaylistNamePayload,
  PositionPayload,
  QueueEntryPayload,
  QueuePlaylistPayload,
  QueueSetPayload,
  SetAccess,
  SetCaller,
  SetPlaylistsPayload,
  SocialFiltersPayload,
  TagsPayload,
  UpdateTitlePayload,
  UpdateMePayload,
} from "@orbis/contracts/http-api";
import { desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema, Scope } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  addKey,
  addPerson,
  AdminError,
  listKeys,
  listPeople,
  removePerson,
  revokeKey,
} from "./admin.js";
import { Audio } from "./audio.js";
import type { AudioFile, AudioOptions } from "./audio.js";
import { Database, layer as databaseLayer } from "./db/database.js";
import { listens } from "./db/schema.js";
import { LibraryError } from "./errors.js";
import type { AccessDecision, AccessMode, TrustStore } from "./identity.js";
import {
  decideAccess,
  markKeyUsed,
  migrateTrustStore,
  readTrustRegistry,
  updatePerson,
  updatePersonFilters,
} from "./identity.js";
import { Library } from "./library.js";
import type { LoggingOptions } from "./logging.js";
import {
  configureLogging,
  finishRequestLog,
  makeRequestLogMiddleware,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";
import type { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import type { EnrichedMetadata } from "./metadata.js";
import { Queue } from "./queue.js";
import { expandShortLink } from "./short-link.js";
import { Stats } from "./stats.js";
import {
  grantSecret,
  issueStreamGrant,
  verifyStreamGrant,
} from "./stream-grant.js";
import type { TitleReviserError } from "./title-reviser-error.js";
import { TitleReviser } from "./title-reviser.js";
import { resolveVisiblePerson } from "./visibility.js";

interface RawFilters {
  creatorId?: string | null;
  playlistId: string;
  q: string;
  tags: string[];
  source?: string | null;
}

class AcceptedAccess extends Context.Service<
  AcceptedAccess,
  Exclude<AccessDecision, { readonly kind: "rejected" }>
>()("Orbis/AcceptedAccess") {}

const funnelOrigin = "https://vanta.tail01d084.ts.net:10000";
const allowedBrowserOrigin = (
  origin: string | null,
  mode: AccessMode,
  development: boolean
): origin is string =>
  mode === "device" &&
  origin !== null &&
  (origin === funnelOrigin ||
    (development && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u.test(origin)));

const browserIngress = (
  request: Request,
  mode: AccessMode,
  development: boolean
): Response | null => {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return null;
  }
  if (!allowedBrowserOrigin(origin, mode, development)) {
    return Response.json(
      { message: "Only local app requests are allowed." },
      { status: 403 }
    );
  }
  if (request.method !== "OPTIONS") {
    return null;
  }
  return new Response(null, {
    headers: {
      "access-control-allow-headers": "authorization, content-type, range",
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "access-control-allow-origin": origin,
      vary: "origin",
    },
    status: 204,
  });
};

const grantAccess = (
  request: Request,
  mode: AccessMode,
  store: TrustStore,
  secret: Buffer
): AccessDecision | null => {
  if (
    mode !== "device" ||
    request.method !== "GET" ||
    request.headers.has("authorization")
  ) {
    return null;
  }
  const url = new URL(request.url);
  const match = /^\/sets\/(?<id>[^/]+)\/audio$/u.exec(url.pathname);
  const grant = url.searchParams.get("grant");
  if (!match?.groups?.id || !grant) {
    return null;
  }
  const personId = verifyStreamGrant(
    secret,
    decodeURIComponent(match.groups.id),
    grant
  );
  const person = store.people.find(
    (candidate) => candidate.id === personId && !candidate.removed
  );
  return person
    ? { keyId: null, kind: "accepted", person, scope: "daily" }
    : { kind: "rejected", message: "Invalid stream grant.", statusCode: 401 };
};

const Tags = TagsPayload.fields.tags;
const Filters = Schema.Struct({
  creatorId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  playlistId: Schema.String.check(Schema.isMaxLength(100)),
  q: Schema.String.check(Schema.isMaxLength(200)),
  source: Schema.optionalKey(Schema.Literals(["youtube", "soundcloud"])),
  tags: Tags,
});
const logDetailsFailure = (set: SavedSet, reason: string) =>
  Effect.logWarning("set details fill failed").pipe(
    Effect.annotateLogs({ reason, set: set.id })
  );

/**
 * A failed library call is the one server-side failure the response status does not
 * explain on its own, so it is logged with the status the client receives. A rejected
 * request body is not logged: its 400 already appears on the request event.
 */
const logLibraryFailure = <E>(error: E) => {
  if (!(error instanceof LibraryError)) {
    return Effect.void;
  }
  const logFailure =
    error.statusCode >= 500 ? Effect.logError : Effect.logWarning;
  return logFailure("library request failed").pipe(
    Effect.annotateLogs({ errorTag: error._tag, status: error.statusCode })
  );
};

const failureResponse = <E>(error: E) => {
  if (error instanceof LibraryError) {
    return HttpServerResponse.jsonUnsafe(
      { message: error.message },
      { status: error.statusCode }
    );
  }
  return HttpServerResponse.jsonUnsafe(
    { message: "Check your request fields and send valid JSON." },
    { status: 400 }
  );
};

const withFailureResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect.pipe(Effect.tapError(logLibraryFailure)), {
    onFailure: failureResponse,
    onSuccess: (body) => body,
  });

type AudioRange =
  | { readonly offset: number; readonly length: number }
  | { readonly unsatisfiable: true };

// AVPlayer seeks with byte ranges on every read, so the range grammar is parsed here
// and an unsatisfiable range is a 416, not a silent full response.
const audioRange = (
  header: string | null | undefined,
  size: number
): AudioRange | null => {
  if (!header) {
    return null;
  }
  const match = /^bytes=(?<first>[0-9]*)-(?<last>[0-9]*)$/u.exec(header.trim());
  if (!match?.groups) {
    return null;
  }
  const { first = "", last = "" } = match.groups;
  if (first === "" && last === "") {
    return null;
  }
  let start = first === "" ? size - Number(last) : Number(first);
  const end = last === "" ? size - 1 : Number(last);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < 0) {
    return null;
  }
  start = Math.max(start, 0);
  if (start >= size) {
    return { unsatisfiable: true };
  }
  return { length: Math.min(end, size - 1) - start + 1, offset: start };
};

const audioFileResponse = (file: AudioFile, range: AudioRange | null) => {
  const headers = {
    "accept-ranges": "bytes",
    "content-type": file.contentType,
  };
  if (!range) {
    return HttpServerResponse.raw(Bun.file(file.path), { headers });
  }
  if ("unsatisfiable" in range) {
    return HttpServerResponse.empty({
      headers: { "content-range": `bytes */${file.bytes}` },
      status: 416,
    });
  }
  return HttpServerResponse.raw(
    Bun.file(file.path).slice(range.offset, range.offset + range.length),
    {
      contentLength: range.length,
      headers: {
        ...headers,
        "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${file.bytes}`,
      },
      status: 206,
    }
  );
};

export const createApp = (
  options: {
    allowDevelopmentOrigins?: boolean;
    audio?: AudioOptions;
    databasePath?: string;
    devicesPath?: string;
    logging?: LoggingOptions;
    metadata?: Layer.Layer<Metadata>;
    /** Follows short links such as `on.soundcloud.com`. Tests pass a stub to stay offline. */
    shortLinkFetch?: (url: string, signal: AbortSignal) => Promise<Response>;
    titleReviser?: Layer.Layer<TitleReviser>;
  } = {}
) => {
  configureLogging(options.logging);
  const databasePath = options.databasePath ?? ":memory:";
  const devicesPath =
    options.devicesPath ??
    (databasePath === ":memory:"
      ? undefined
      : path.join(path.dirname(databasePath), "devices.json"));
  const development = options.allowDevelopmentOrigins === true;
  const streamSecret = grantSecret(
    databasePath === ":memory:"
      ? undefined
      : path.join(path.dirname(databasePath), "stream-grant.key")
  );
  const failedKeys = new Map<string, { count: number; until: number }>();
  if (devicesPath) {
    migrateTrustStore(devicesPath);
  }
  const database = databaseLayer({
    databasePath,
    migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
  });
  // The Database layer is one value used by every service that writes.
  const libraryLayer = Library.layer.pipe(Layer.provide(database));
  const routes = Layer.effectDiscard(
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const db = yield* Database;
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
      const scope = yield* Scope.Scope;
      const reviseTitle = Effect.fn("reviseSavedSetTitle")((
        set: SavedSet,
        enriched: EnrichedMetadata
      ) => {
        const keepProviderTitle = (error: TitleReviserError) =>
          Effect.logWarning("set title revision failed").pipe(
            Effect.annotateLogs({ reason: error.reason, set: set.id }),
            Effect.as(enriched)
          );
        return titleReviser
          .revise({
            creator: enriched.creator,
            source: set.source,
            title: enriched.title,
          })
          .pipe(
            Effect.map((title) => ({ ...enriched, title })),
            // A revision failure keeps the provider title: a bad rename must
            // never fail enrichment, which already has a retry path.
            Effect.catchTag("TitleReviserError", keepProviderTitle)
          );
      });
      // The slow yt-dlp read runs after the response, tied to the app so `dispose` stops it. A
      // failure is logged and marks the Set's details failed; the save itself is unaffected.
      const fillDetails = Effect.fn("fillSavedSetDetails")((set: SavedSet) =>
        metadata.details({ source: set.source, url: set.url }).pipe(
          Effect.flatMap((details) => library.recordDetails(set.id, details)),
          Effect.catchTags({
            LibraryError: (error) => logDetailsFailure(set, error.message),
            MetadataError: (error) =>
              error.reason === "not-configured"
                ? Effect.void
                : logDetailsFailure(set, error.reason).pipe(
                    Effect.andThen(
                      library.recordDetailsFailure(set.id).pipe(Effect.ignore)
                    )
                  ),
          }),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      );
      // Enrichment failure is swallowed so the save still succeeds, so it is the
      // one outcome a client cannot see. The log records which set and which reason.
      const enrichSavedSet = Effect.fn("enrichSavedSet")((
        set: SavedSet,
        personal: typeof Library.Service
      ) => {
        const onMetadataFailure = (error: MetadataError) =>
          Effect.logWarning("set metadata enrichment failed").pipe(
            Effect.annotateLogs({ reason: error.reason, set: set.id }),
            Effect.andThen(library.recordEnrichmentFailure(set.id))
          );
        return metadata.enrich({ source: set.source, url: set.url }).pipe(
          Effect.flatMap((enriched) => reviseTitle(set, enriched)),
          Effect.flatMap((enriched) =>
            library
              .recordEnrichment(set.id, enriched)
              // The yt-dlp fallback already stored the details, so a second read is skipped.
              .pipe(
                Effect.tap(() =>
                  enriched.extras ? Effect.void : fillDetails(set)
                )
              )
          ),
          Effect.catchTag("MetadataError", (failure) =>
            onMetadataFailure(failure).pipe(Effect.tap(() => fillDetails(set)))
          ),
          Effect.flatMap(() => personal.find(set.id))
        );
      });
      const autoDownloadSaved = Effect.fn("AutoDownload.onSave")(
        function* autoDownloadSaved(saved: SavedSet) {
          const { person } = yield* SetCaller;
          const result = (
            autoDownloadResult: (typeof SaveSetResultSchema.Type)["autoDownloadResult"],
            set?: SavedSet
          ) => ({ ...(set ?? saved), autoDownloadResult });
          if (person.autoDownload === false) {
            return result("disabled");
          }
          if (saved.downloadState === "ready") {
            return result("ready");
          }
          if (
            saved.downloadState === "queued" ||
            saved.downloadState === "downloading"
          ) {
            return result("inProgress");
          }
          if (!audio.isConfigured) {
            return result("unavailable");
          }
          return yield* audio.requestDownload(saved.id).pipe(
            Effect.map(({ set, accepted }) =>
              result(accepted ? "queued" : "inProgress", set)
            ),
            Effect.catchTag("LibraryError", (error) =>
              error.statusCode === 429
                ? Effect.succeed(result("queueFull"))
                : Effect.fail(error)
            )
          );
        }
      );
      const setGroup = HttpApiBuilder.group(OrbisApi, "sets", (handlers) =>
        handlers
          .handleRaw("requestDownload", ({ params }) =>
            Effect.match(
              Effect.gen(function* requestPersonalDownload() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                const result = yield* audio.requestDownload(params.id);
                return { ...result, set: yield* personal.find(params.id) };
              }).pipe(Effect.tapError(logLibraryFailure)),
              {
                onFailure: failureResponse,
                onSuccess: ({ accepted, set }) =>
                  HttpServerResponse.jsonUnsafe(set, {
                    status: accepted ? 202 : 200,
                  }),
              }
            )
          )
          .handle("audioState", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* personalAudioState() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                return yield* audio.audioState(params.id);
              })
            )
          )
          .handleRaw("audioGrant", ({ params }) =>
            Effect.gen(function* grantAudio() {
              const caller = yield* SetCaller;
              const personal = yield* Library;
              yield* personal.find(params.id);
              const result = yield* Effect.match(audio.audioFile(params.id), {
                onFailure: failureResponse,
                onSuccess: () =>
                  HttpServerResponse.jsonUnsafe({
                    url: `/sets/${encodeURIComponent(params.id)}/audio?grant=${issueStreamGrant(streamSecret, params.id, caller.person.id)}`,
                  }),
              });
              return result;
            })
          )
          .handleRaw("audio", ({ params, request }) =>
            Effect.match(
              Effect.gen(function* personalAudioFile() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                return yield* audio.audioFile(params.id);
              }).pipe(
                Effect.map((file) =>
                  audioFileResponse(
                    file,
                    audioRange(
                      Option.getOrUndefined(
                        Headers.get(request.headers, "range")
                      ),
                      file.bytes
                    )
                  )
                ),
                Effect.tapError(logLibraryFailure)
              ),
              { onFailure: failureResponse, onSuccess: (response) => response }
            )
          )
          .handle("cancelDownload", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* cancelPersonalDownload() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                yield* audio.cancelDownload(params.id);
                return yield* personal.find(params.id);
              })
            )
          )
          .handleRaw("save", () =>
            withFailureResponse(
              Effect.gen(function* saveSet() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(SaveSetPayload);
                const url = yield* expandShortLink(
                  input.url,
                  options.shortLinkFetch
                );
                const personal = yield* Library;
                const saved = yield* personal.save({
                  tags: [...(input.tags ?? [])],
                  title: input.title ?? "",
                  url,
                });
                yield* Effect.logInfo("set saved").pipe(
                  Effect.annotateLogs({ set: saved.id, source: saved.source })
                );
                if (
                  saved.titleEditedByUser ||
                  saved.metadataState === "enriched"
                ) {
                  yield* fillDetails(saved);
                  return yield* autoDownloadSaved(saved);
                }
                return yield* autoDownloadSaved(
                  yield* enrichSavedSet(saved, personal)
                );
              })
            )
          )
          .handle("retryMetadata", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* retrySetMetadata() {
                const personal = yield* Library;
                const set = yield* personal.find(params.id);
                return yield* enrichSavedSet(set, personal);
              })
            )
          )
          .handleRaw("updateTitle", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* updateSetTitle() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateTitlePayload);
                const personal = yield* Library;
                return yield* personal.updateTitle(params.id, input.title);
              })
            )
          )
          .handle("remove", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* removePersonalSet() {
                const personal = yield* Library;
                return yield* personal.remove(params.id);
              })
            )
          )
          .handleRaw("list", ({ request }) =>
            withFailureResponse(
              Effect.gen(function* listSets() {
                const params = new URL(request.url, "http://localhost")
                  .searchParams;
                const rawFilters: RawFilters = {
                  playlistId: params.get("playlistId") ?? "",
                  q: params.get("q") ?? "",
                  tags: params.getAll("tag"),
                };
                if (params.has("creatorId")) {
                  rawFilters.creatorId = params.get("creatorId");
                }
                if (params.has("source")) {
                  rawFilters.source = params.get("source");
                }
                const filters =
                  yield* Schema.decodeUnknownEffect(Filters)(rawFilters);
                const personal = yield* Library;
                const sets = yield* personal.list({
                  ...filters,
                  tags: [...filters.tags],
                });
                return { sets };
              })
            )
          )
      );
      const playlistGroup = HttpApiBuilder.group(
        OrbisApi,
        "playlists",
        (handlers) =>
          handlers
            .handle("list", () =>
              withFailureResponse(
                Effect.gen(function* listPersonalPlaylists() {
                  const personal = yield* Library;
                  return { playlists: yield* personal.playlists() };
                })
              )
            )
            .handleRaw("create", () =>
              withFailureResponse(
                Effect.gen(function* createPlaylist() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      PlaylistNamePayload
                    );
                  const personal = yield* Library;
                  return yield* personal.createPlaylist(input.name);
                })
              )
            )
            .handleRaw("rename", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* renamePlaylist() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      PlaylistNamePayload
                    );
                  const personal = yield* Library;
                  return yield* personal.renamePlaylist(params.id, input.name);
                })
              )
            )
            .handle("remove", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* removePersonalPlaylist() {
                  const personal = yield* Library;
                  return yield* personal.deletePlaylist(params.id);
                })
              )
            )
            .handleRaw("replaceMembers", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* replacePlaylistMembers() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    PlaylistMembersPayload
                  );
                  const personal = yield* Library;
                  return {
                    sets: yield* personal.setPlaylistMembers(
                      params.id,
                      input.setIds
                    ),
                  };
                })
              )
            )
            .handleRaw("replaceSetPlaylists", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* replaceSetPlaylists() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      SetPlaylistsPayload
                    );
                  const personal = yield* Library;
                  return yield* personal.setPlaylistMemberships(
                    params.id,
                    input.playlistIds
                  );
                })
              )
            )
      );
      const queueGroup = HttpApiBuilder.group(OrbisApi, "queue", (handlers) =>
        handlers
          .handle("read", () =>
            withFailureResponse(
              Effect.gen(function* readPersonalQueue() {
                const queue = yield* Queue;
                return { queue: yield* queue.read() };
              })
            )
          )
          .handleRaw("play", () =>
            withFailureResponse(
              Effect.gen(function* setActiveQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
                const queue = yield* Queue;
                return { queue: yield* queue.play(input.setId) };
              })
            )
          )
          .handleRaw("insert", () =>
            Effect.map(
              withFailureResponse(
                Effect.gen(function* addQueueEntry() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(QueueEntryPayload);
                  const queue = yield* Queue;
                  return {
                    queue: yield* queue.insert(input.setId, input.placement),
                  };
                })
              ),
              (result) =>
                HttpServerResponse.isHttpServerResponse(result)
                  ? result
                  : HttpServerResponse.jsonUnsafe(result, { status: 201 })
            )
          )
          .handleRaw("replaceWithPlaylist", () =>
            withFailureResponse(
              Effect.gen(function* replaceQueueFromPlaylist() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueuePlaylistPayload);
                const queue = yield* Queue;
                return {
                  queue: yield* queue.replaceWithPlaylist(input.playlistId),
                };
              })
            )
          )
          .handleRaw("complete", () =>
            withFailureResponse(
              Effect.gen(function* completeQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
                const queue = yield* Queue;
                return { queue: yield* queue.complete(input.setId) };
              })
            )
          )
      );
      const libraryGroup = HttpApiBuilder.group(
        OrbisApi,
        "library",
        (handlers) =>
          handlers
            .handleRaw("setPosition", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* setPlaybackPosition() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(PositionPayload);
                  const personal = yield* Library;
                  return yield* personal.setPlaybackPosition(
                    params.id,
                    input.seconds
                  );
                })
              )
            )
            .handle("tags", () =>
              withFailureResponse(
                Effect.gen(function* listPersonalTags() {
                  const personal = yield* Library;
                  return { tags: yield* personal.tags() };
                })
              )
            )
            .handleRaw("updateTags", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* updateTags() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(TagsPayload);
                  const personal = yield* Library;
                  return yield* personal.updateTags(params.id, input.tags);
                })
              )
            )
      );
      const visibleFriend = (id: string) =>
        Effect.gen(function* resolveFriend() {
          const caller = yield* SetCaller;
          const { people } = readTrustRegistry(devicesPath).store;
          return yield* Effect.try({
            catch: (error) =>
              error instanceof LibraryError
                ? error
                : new LibraryError({
                    message: "Could not read People.",
                    statusCode: 500,
                  }),
            try: () => resolveVisiblePerson(people, caller.person.id, id),
          });
        });
      const friendLibraryLayer = (personId: string) =>
        Library.forPersonLayer(personId).pipe(
          Layer.provide(Layer.succeed(Database, db))
        );
      const peopleGroup = HttpApiBuilder.group(OrbisApi, "people", (handlers) =>
        handlers
          .handle("me", () =>
            Effect.gen(function* readMe() {
              const { person } = yield* SetCaller;
              return {
                autoDownload: person.autoDownload ?? true,
                id: person.id,
                social: person.social ?? false,
                username: person.username,
              };
            })
          )
          .handleRaw("updateMe", () =>
            withFailureResponse(
              Effect.gen(function* updateMe() {
                const caller = yield* SetCaller;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateMePayload);
                const result = updatePerson(
                  devicesPath,
                  caller.person.id,
                  input
                );
                if (result.kind === "updated") {
                  return HttpServerResponse.jsonUnsafe({
                    autoDownload: result.person.autoDownload ?? true,
                    id: result.person.id,
                    social: result.person.social ?? false,
                    username: result.person.username,
                  });
                }
                let statusCode = 500;
                let message = "The trust store is unavailable.";
                if (result.kind === "invalid") {
                  statusCode = 400;
                  message = "Choose a username with 1 to 40 characters.";
                } else if (result.kind === "conflict") {
                  statusCode = 409;
                  message = "That username is already in use.";
                }
                return yield* new LibraryError({ message, statusCode });
              })
            )
          )
          .handleRaw("list", () =>
            withFailureResponse(
              Effect.gen(function* listVisiblePeople() {
                const caller = yield* SetCaller;
                const { people } = readTrustRegistry(devicesPath).store;
                return {
                  people: people.flatMap((person) => {
                    try {
                      const visible = resolveVisiblePerson(
                        people,
                        caller.person.id,
                        person.id
                      );
                      return [{ id: visible.id, username: visible.username }];
                    } catch {
                      return [];
                    }
                  }),
                };
              })
            )
          )
          .handleRaw("filters", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* setSocialFilters() {
                const caller = yield* SetCaller;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(SocialFiltersPayload);
                const result = updatePersonFilters(
                  devicesPath,
                  caller.person.id,
                  params.id,
                  input
                );
                if (result.kind === "updated") {
                  return { appear: result.appear, see: result.see };
                }
                return yield* new LibraryError({
                  message:
                    result.kind === "invalid"
                      ? "Choose at least one filter."
                      : "Person not found.",
                  statusCode: { invalid: 400, missing: 404, unavailable: 500 }[
                    result.kind
                  ],
                });
              })
            )
          )
          .handleRaw("sets", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendLibrary() {
                const target = yield* visibleFriend(params.id);
                const sets = yield* Effect.provide(
                  Effect.gen(function* listFriendSets() {
                    const personal = yield* Library;
                    return yield* personal.list({});
                  }),
                  friendLibraryLayer(target.id)
                );
                return { sets };
              })
            )
          )
          .handleRaw("friendPlaylists", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendPlaylists() {
                const target = yield* visibleFriend(params.id);
                const playlists = yield* Effect.provide(
                  Effect.gen(function* listFriendPlaylists() {
                    const personal = yield* Library;
                    const owned = yield* personal.playlists();
                    // eslint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach is not Array.forEach.
                    return yield* Effect.forEach(owned, (playlist) =>
                      Effect.map(
                        personal.list({ playlistId: playlist.id }),
                        (sets) => ({
                          ...playlist,
                          sets,
                        })
                      )
                    );
                  }),
                  friendLibraryLayer(target.id)
                );
                return { playlists };
              })
            )
          )
          .handleRaw("friendListens", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* readFriendListens() {
                const target = yield* visibleFriend(params.id);
                const rows = yield* db
                  .select({
                    finishedAt: listens.finishedAt,
                    id: listens.id,
                    setId: listens.setId,
                    startedAt: listens.startedAt,
                  })
                  .from(listens)
                  .where(eq(listens.personId, target.id))
                  .orderBy(desc(listens.startedAt), desc(listens.id));
                const history = yield* Effect.provide(
                  Effect.gen(function* hydrateFriendListens() {
                    const personal = yield* Library;
                    const sets = yield* personal.byIds(
                      rows.map((row) => row.setId)
                    );
                    const byId = new Map(sets.map((set) => [set.id, set]));
                    return rows.flatMap((row) => {
                      const set = byId.get(row.setId);
                      return set
                        ? [
                            {
                              finishedAt: row.finishedAt,
                              set,
                              startedAt: row.startedAt,
                            },
                          ]
                        : [];
                    });
                  }),
                  friendLibraryLayer(target.id)
                );
                return { listens: history };
              })
            )
          )
      );
      const requireAdminScope = Effect.gen(function* verifyAdminScope() {
        const caller = yield* SetCaller;
        if (
          caller.keyId === null ||
          caller.scope !== "admin" ||
          caller.person.id !== "host"
        ) {
          return yield* new LibraryError({
            message: "An admin key is required.",
            statusCode: 403,
          });
        }
      });
      const adminCall = <A>(action: (storePath: string) => A) =>
        Effect.gen(function* authorizedAdminAction() {
          yield* requireAdminScope;
          return yield* Effect.try({
            catch: (error) =>
              new LibraryError({
                message:
                  error instanceof AdminError
                    ? error.message
                    : "The trust store is unavailable.",
                statusCode:
                  error instanceof AdminError ? error.statusCode : 500,
              }),
            try: () => {
              if (!devicesPath) {
                throw new AdminError(500, "The trust store is unavailable.");
              }
              return action(devicesPath);
            },
          });
        });
      const adminGroup = HttpApiBuilder.group(OrbisApi, "admin", (handlers) =>
        handlers
          .handleRaw("people", () =>
            withFailureResponse(
              Effect.map(adminCall(listPeople), (people) => ({ people }))
            )
          )
          .handleRaw("addPerson", () =>
            withFailureResponse(
              Effect.gen(function* addAdminPerson() {
                yield* requireAdminScope;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(AdminPersonPayload);
                const person = yield* adminCall((storePath) =>
                  addPerson(storePath, input.username)
                );
                return HttpServerResponse.jsonUnsafe(person, { status: 201 });
              })
            )
          )
          .handleRaw("removePerson", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* removeAdminPerson() {
                const person = yield* adminCall((storePath) =>
                  removePerson(storePath, params.id)
                );
                yield* db
                  .transaction((tx) =>
                    Effect.gen(function* deleteAdminPersonRows() {
                      yield* tx.run(
                        sql`DELETE FROM playlist_sets WHERE playlist_id IN (SELECT id FROM playlists WHERE creator_id = ${params.id})`
                      );
                      yield* tx.run(
                        sql`DELETE FROM playlists WHERE creator_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM queue_entries WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM playback_positions WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM listens WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM library_entries WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`UPDATE sets SET download_state = 'none'
                          WHERE download_state IN ('queued', 'downloading')
                          AND id IN (SELECT set_id FROM download_jobs WHERE person_id = ${params.id})`
                      );
                      yield* tx.run(
                        sql`DELETE FROM download_jobs WHERE person_id = ${params.id}`
                      );
                      yield* tx.run(
                        sql`DELETE FROM download_requesters WHERE person_id = ${params.id}`
                      );
                    })
                  )
                  .pipe(
                    Effect.mapError(
                      () =>
                        new LibraryError({
                          message: "Could not remove the Person's data.",
                          statusCode: 500,
                        })
                    )
                  );
                return person;
              })
            )
          )
          .handleRaw("keys", () =>
            withFailureResponse(
              Effect.map(
                adminCall((storePath) => listKeys(storePath)),
                (keys) => ({ keys })
              )
            )
          )
          .handleRaw("personKeys", ({ params }) =>
            withFailureResponse(
              Effect.map(
                adminCall((storePath) => listKeys(storePath, params.id)),
                (keys) => ({ keys })
              )
            )
          )
          .handleRaw("addKey", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* addAdminKey() {
                yield* requireAdminScope;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(AdminKeyPayload);
                const key = yield* adminCall((storePath) =>
                  addKey(storePath, params.id, input)
                );
                return HttpServerResponse.jsonUnsafe(key, { status: 201 });
              })
            )
          )
          .handleRaw("revokeKey", ({ params }) =>
            withFailureResponse(
              adminCall((storePath) => revokeKey(storePath, params.id))
            )
          )
      );
      const systemGroup = HttpApiBuilder.group(OrbisApi, "system", (handlers) =>
        handlers.handle("health", () =>
          Effect.succeed({ status: "ok" as const })
        )
      );
      yield* Layer.buildWithScope(
        HttpApiBuilder.layer(OrbisApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(setGroup),
          Layer.provide(playlistGroup),
          Layer.provide(queueGroup),
          Layer.provide(libraryGroup),
          Layer.provide(systemGroup),
          Layer.provide(peopleGroup),
          Layer.provide(adminGroup),
          Layer.provide(
            Layer.succeed(SetAccess, {
              bearer: (effect) =>
                Effect.flatMap(
                  Effect.withFiberSucceed((fiber) =>
                    Context.getOption(fiber.context, AcceptedAccess)
                  ),
                  Option.match({
                    onNone: () => Effect.die("Accepted access context missing"),
                    onSome: (access) => {
                      const personalLibrary = Library.forPersonLayer(
                        access.person.id
                      ).pipe(Layer.provide(Layer.succeed(Database, db)));
                      const personalQueue = Queue.forPersonLayer(
                        access.person.id
                      ).pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            Layer.succeed(Database, db),
                            personalLibrary,
                            Stats.forPersonLayer(access.person.id).pipe(
                              Layer.provide(Layer.succeed(Database, db))
                            )
                          )
                        )
                      );
                      return Effect.provide(
                        Effect.provideService(effect, SetCaller, access),
                        Layer.mergeAll(personalLibrary, personalQueue)
                      );
                    },
                  })
                ),
            })
          ),
          Layer.provide(HttpServer.layerServices)
        ),
        scope
      );
    })
  );
  const app = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(Audio.layer(options.audio ?? {})),
      Layer.provide(libraryLayer),
      Layer.provide(options.metadata ?? Metadata.unconfigured()),
      Layer.provide(options.titleReviser ?? TitleReviser.unconfigured()),
      Layer.provide(database)
    ),
    {
      disableLogger: true,
      middleware: makeRequestLogMiddleware(options.logging),
    }
  );
  return {
    dispose: app.dispose,
    handler: (
      request: Request,
      mode: AccessMode = "local",
      clientAddress = "unknown"
    ): Promise<Response> => {
      const origin = request.headers.get("origin");
      const browserResponse = browserIngress(request, mode, development);
      if (browserResponse) {
        return Promise.resolve(browserResponse);
      }
      const withOrigin = (response: Response): Response => {
        if (allowedBrowserOrigin(origin, mode, development)) {
          response.headers.set("access-control-allow-origin", origin);
          response.headers.set("vary", "origin");
        }
        return response;
      };
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const authorization = request.headers.get("authorization");
      const registry = readTrustRegistry(devicesPath);
      const streamDecision = grantAccess(
        request,
        mode,
        registry.store,
        streamSecret
      );
      if (
        new URL(request.url).searchParams.has("grant") &&
        streamDecision?.kind !== "accepted"
      ) {
        return Promise.resolve(
          withOrigin(
            Response.json({ message: "Invalid stream grant." }, { status: 401 })
          )
        );
      }
      const decision =
        streamDecision ??
        decideAccess({
          authorization,
          hasOrigin: false,
          host,
          mode,
          store: registry.store,
        });
      if (
        mode === "device" &&
        authorization !== null &&
        decision.kind === "rejected" &&
        decision.statusCode === 401
      ) {
        const client = clientAddress;
        const previous = failedKeys.get(client);
        const count =
          previous && previous.until > Date.now() ? previous.count + 1 : 1;
        failedKeys.set(client, { count, until: Date.now() + 60_000 });
        if (count > 20) {
          return Promise.resolve(
            withOrigin(
              Response.json(
                { message: "Too many invalid keys." },
                { status: 429 }
              )
            )
          );
        }
      }
      if (decision.kind === "rejected") {
        const logger = startRequestLog({
          method: request.method,
          path: safeRequestPath(request.url),
          requestId: crypto.randomUUID(),
        });
        if (registry.storeError !== undefined) {
          // A damaged trust store refuses every device. Without this field the
          // only visible symptom is a sudden run of 401 responses.
          logger.set({ trustStore: registry.storeError });
        }
        finishRequestLog(
          logger,
          { outcome: "rejected", status: decision.statusCode },
          options.logging
        );
        return Promise.resolve(
          withOrigin(
            Response.json(
              { message: decision.message },
              { status: decision.statusCode }
            )
          )
        );
      }
      markKeyUsed(devicesPath, decision.keyId);
      // SAFETY: SetAccess provides the caller-bound Library and Queue before handlers read them.
      return app
        .handler(
          request,
          Context.add(
            Context.make(SetCaller, decision),
            AcceptedAccess,
            decision
          ) as Context.Context<Library | Queue | SetCaller>
        )
        .then(withOrigin);
    },
  };
};
