import type { SavedSet } from "@orbis/contracts";
import type { SaveSetResultSchema } from "@orbis/contracts/http-api";
import {
  AdminKeyPayload,
  AdminPersonPayload,
  CollaborationPayload,
  DeviceLinkCodePayload,
  DeviceLinkPollPayload,
  DeviceLinkStartPayload,
  InviteClaimPayload,
  SaveSetPayload,
  OrbisApi,
  PlaylistMembersPayload,
  PlaylistEditorsPayload,
  PlaylistNamePayload,
  PositionPayload,
  PresenceActionPayload,
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
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
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
  listDevices,
  listKeys,
  listPeople,
} from "./admin.js";
import { Audio } from "./audio-service.js";
import type { AudioFile } from "./audio-service.js";
import {
  listens,
  playlistEditors,
  playlistSets,
  playlists,
  sets as setRows,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { DEVICE_LINK_TTL_MS, makeDeviceLinks } from "./device-link.js";
import { LibraryError } from "./errors.js";
import type { FeedNotice } from "./feed-signals.js";
import { FeedSignals } from "./feed-signals.js";
import { makeFeed, visiblePresence } from "./feed.js";
import type { CatchUp } from "./feed.js";
import type { AccessDecision, AccessMode, TrustStore } from "./identity.js";
import { decideAccess, markKeyUsed, readTrustRegistry } from "./identity.js";
import { consumeInvite, createInvite, INVITE_TTL_MS } from "./invite.js";
import { Journal } from "./journal.js";
import type { JournalOptions } from "./journal.js";
import { Library } from "./library.js";
import type { LoggingOptions } from "./logging.js";
import {
  annotateForwardedRequest,
  configureLogging,
  finishRequestLog,
  loggingLayer,
  makeRequestLogMiddleware,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";
import type { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import type { EnrichedMetadata } from "./metadata.js";
import { Presence } from "./presence.js";
import type { PresenceOptions } from "./presence.js";
import { QueueSignals } from "./queue-signals.js";
import { Queue } from "./queue.js";
import { expandShortLink } from "./short-link.js";
import { Stats } from "./stats.js";
import { issueStreamGrant, verifyStreamGrant } from "./stream-grant-core.js";
import type { TitleReviserError } from "./title-reviser-error.js";
import { TitleReviser } from "./title-reviser.js";
import {
  claimTracklist,
  readTracklist,
  runClaimedTracklist,
} from "./tracklists.js";
import { retryTrustOperation } from "./trust-storage.js";
import {
  removePerson,
  revokeKey,
  updatePerson,
  updatePersonFilters,
} from "./trust-writes.js";
import { Versos } from "./versos.js";
import {
  listFilterablePeople,
  resolveEditablePlaylist,
  resolveVisiblePerson,
} from "./visibility.js";

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

const grantAccess = (
  request: Request,
  mode: AccessMode,
  store: TrustStore,
  secret: Buffer
): AccessDecision | null => {
  if (mode !== "device" || request.method !== "GET") {
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

const rejectedStreamGrant = (
  request: Request,
  decision: AccessDecision | null
) =>
  new URL(request.url).searchParams.has("grant") &&
  decision?.kind !== "accepted";

const forwardedResponse = (
  request: Request,
  response: Response,
  store: TrustStore,
  keyId: string | null
) => {
  if (request.headers.get("x-orbis-ingress") === "funnel-forward") {
    const key = store.keys.find((record) => record.id === keyId);
    if (key) {
      response.headers.set("x-orbis-key-label", encodeURIComponent(key.label));
    }
  }
  return response;
};

const PRESENCE_WINDOW_MS = 30_000;
/** Failed key attempts one client may make in a minute before it gets 429. */
const FAILED_KEY_LIMIT = 20;
const tooManyAttempts = () =>
  Response.json({ message: "Too many invalid keys." }, { status: 429 });
/**
 * Routes a new device calls before it has a key (ADR 0016). They pass the Origin
 * check like every route, and each start, unknown poll secret, or failed Invite
 * claim counts toward the failed-key limit.
 */
const OPEN_ROUTES: ReadonlySet<string> = new Set([
  "/device-links",
  "/device-links/poll",
]);
/** Redeems a code whatever the Authorization header says, so a key cannot skip the limit. */
const INVITE_CLAIM_ROUTE = "/invites/claim";
const INVITE_FAILURES = {
  expired: {
    message: "This Invite has expired. Ask the Host for a new one.",
    statusCode: 410,
  },
  missing: {
    message: "This Invite link is not valid. Ask the Host for a new one.",
    statusCode: 404,
  },
  used: {
    message: "This Invite has already been used. Ask the Host for a new one.",
    statusCode: 409,
  },
} as const;
const LINK_FAILURES = {
  approved: { message: "That code is already approved.", statusCode: 409 },
  expired: {
    message: "That code has expired. Start again on the new device.",
    statusCode: 410,
  },
  missing: { message: "No device is waiting with that code.", statusCode: 404 },
} as const;
const linkFailure = (kind: keyof typeof LINK_FAILURES): LibraryError =>
  new LibraryError(LINK_FAILURES[kind]);
const linkBody = (label: string, expiresAt: number) => ({
  expiresAt: new Date(expiresAt).toISOString(),
  label,
});
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

const missingPlaylist = () =>
  new LibraryError({ message: "Playlist not found.", statusCode: 404 });

const withFailureResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect.pipe(Effect.tapError(logLibraryFailure)), {
    onFailure: failureResponse,
    onSuccess: (body) => body,
  });

export const createPortableApp = (options: {
  audio: Layer.Layer<Audio, never, Library>;
  audioResponse: (
    file: AudioFile,
    range: string | undefined,
    setId: string,
    personId: string,
    grant: string | null
  ) => HttpServerResponse.HttpServerResponse;
  releaseAudio: (id: string) => Effect.Effect<void, LibraryError, Database>;
  streamSecret: Buffer;
  database: Layer.Layer<Database, unknown>;
  trustPath?: string | undefined;
  logging?: LoggingOptions;
  recordKeyUse?: boolean;
  metadata?: Layer.Layer<Metadata>;
  /** How long after a Playback Position report a Person still counts as listening. */
  presenceWindowMs?: number;
  presence?: PresenceOptions;
  /** Retention bounds for the change feed. Tests shorten them to prove pruning. */
  feed?: JournalOptions;
  /** Shared with any other runtime on the same database, so its commits wake this app's feed readers. */
  feedSignals?: typeof FeedSignals.Service;
  /** How long a Device Link stays open. Tests shorten it to prove expiry. */
  deviceLinkTtlMs?: number;
  deviceLinkNow?: () => number;
  /** How long an Invite stays claimable. Tests shorten it to prove expiry. */
  inviteTtlMs?: number;
  /** Follows short links such as `on.soundcloud.com`. Tests pass a stub to stay offline. */
  shortLinkFetch?: (url: string, signal: AbortSignal) => Promise<Response>;
  titleReviser?: Layer.Layer<TitleReviser>;
  versos?: Layer.Layer<Versos>;
}) => {
  configureLogging(options.logging);
  const { trustPath } = options;
  const { streamSecret } = options;
  const failedKeys = new Map<string, { count: number; until: number }>();
  /** Counts one failed attempt for a client; true once the client is over the limit. */
  const recordFailedKey = (client: string): boolean => {
    const previous = failedKeys.get(client);
    const count =
      previous && previous.until > Date.now() ? previous.count + 1 : 1;
    failedKeys.set(client, { count, until: Date.now() + 60_000 });
    return count > FAILED_KEY_LIMIT;
  };
  const overFailedKeyLimit = (client: string): boolean => {
    const previous = failedKeys.get(client);
    return (
      previous !== undefined &&
      previous.until > Date.now() &&
      previous.count > FAILED_KEY_LIMIT
    );
  };
  const deviceLinks = makeDeviceLinks({
    now: options.deviceLinkNow ?? Date.now,
    ttlMs: options.deviceLinkTtlMs ?? DEVICE_LINK_TTL_MS,
  });
  const { database } = options;
  const libraryOptions = {
    people: () => readTrustRegistry(trustPath).store.people,
    releaseAudio: options.releaseAudio,
  };
  const feedSignals = options.feedSignals ?? FeedSignals.make();
  const journalLayer = Journal.layer(options.feed).pipe(
    Layer.provide(database),
    Layer.provide(Layer.succeed(FeedSignals, feedSignals))
  );
  const storage = Layer.mergeAll(database, journalLayer);
  const libraryLayer = Library.forPersonLayer("host", libraryOptions).pipe(
    Layer.provide(storage)
  );
  const queueSignalsLayer = QueueSignals.layer;
  const presenceLayer = Presence.layer({
    ...options.presence,
    legacyReportWindowMs: options.presenceWindowMs ?? PRESENCE_WINDOW_MS,
  }).pipe(Layer.provide(storage));
  let presenceService: typeof Presence.Service | null = null;
  let feedReader: ReturnType<typeof makeFeed> | null = null;
  const routes = Layer.effectDiscard(
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const db = yield* Database;
      const journal = yield* Journal;
      const presence = yield* Presence;
      presenceService = presence;
      const services = Layer.mergeAll(
        Layer.succeed(Database, db),
        Layer.succeed(Journal, journal)
      );
      const libraryFor = (
        personId: string,
        settings: Parameters<typeof Library.forPersonLayer>[1] = libraryOptions
      ) =>
        Library.forPersonLayer(personId, settings).pipe(
          Layer.provide(services)
        );
      const trustWrite = <A, E, R>(
        body: (tx: DatabaseClient) => Effect.Effect<A, E, R>
      ) =>
        journal.transaction(body).pipe(
          Effect.mapError((failure) =>
            failure instanceof LibraryError
              ? failure
              : new LibraryError({
                  message: "The trust store is unavailable.",
                  statusCode: 500,
                })
          )
        );
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
      const versos = yield* Versos;
      const scope = yield* Scope.Scope;
      const signals = yield* QueueSignals;
      const runningTracklists = new Set<string>();
      const startTracklist = Effect.fn("startSavedSetTracklist")(
        (id: string, retry = false) =>
          Effect.gen(function* startSavedSetTracklist() {
            if (runningTracklists.has(id)) {
              return;
            }
            runningTracklists.add(id);
            let handedOff = false;
            yield* Effect.gen(function* launchTracklist() {
              const claim = yield* claimTracklist(id, retry).pipe(
                Effect.provideService(Database, db)
              );
              if (!claim) {
                return;
              }
              yield* runClaimedTracklist(claim).pipe(
                Effect.interruptible,
                Effect.provideService(Database, db),
                Effect.provideService(Versos, versos),
                Effect.ensuring(
                  Effect.sync(() => {
                    runningTracklists.delete(id);
                  })
                ),
                Effect.forkIn(scope, { startImmediately: true })
              );
              handedOff = true;
            }).pipe(
              Effect.uninterruptible,
              Effect.ensuring(
                Effect.sync(() => {
                  if (!handedOff) {
                    runningTracklists.delete(id);
                  }
                })
              )
            );
          })
      );
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
          Effect.tap(() => startTracklist(set.id)),
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
                  enriched.extras ? startTracklist(set.id) : fillDetails(set)
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
            Effect.gen(function* serveAudio() {
              const caller = yield* SetCaller;
              return yield* Effect.match(
                Effect.gen(function* personalAudioFile() {
                  const personal = yield* Library;
                  yield* personal.find(params.id);
                  return yield* audio.audioFile(params.id);
                }).pipe(
                  Effect.map((file) =>
                    options.audioResponse(
                      file,
                      Option.getOrUndefined(
                        Headers.get(request.headers, "range")
                      ),
                      params.id,
                      caller.person.id,
                      new URL(request.url, "http://localhost").searchParams.get(
                        "grant"
                      )
                    )
                  ),
                  Effect.tapError(logLibraryFailure)
                ),
                {
                  onFailure: failureResponse,
                  onSuccess: (response) => response,
                }
              );
            })
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
          .handle("tracklist", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* getSetTracklist() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                return yield* readTracklist(params.id).pipe(
                  Effect.provideService(Database, db)
                );
              })
            )
          )
          .handle("retryTracklist", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* retrySetTracklist() {
                const personal = yield* Library;
                yield* personal.find(params.id);
                const [set] = yield* db
                  .select({ detailsState: setRows.detailsState })
                  .from(setRows)
                  .where(eq(setRows.id, params.id));
                yield* set?.detailsState === "filled"
                  ? startTracklist(params.id, true)
                  : fillDetails(yield* personal.find(params.id));
                return yield* readTracklist(params.id).pipe(
                  Effect.provideService(Database, db)
                );
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
                const queue = yield* Queue;
                return yield* personal
                  .remove(params.id)
                  .pipe(Effect.tap(queue.notify));
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
      const visibleFriend = (id: string) =>
        Effect.gen(function* resolveFriend() {
          const caller = yield* SetCaller;
          const { people } = readTrustRegistry(trustPath).store;
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
      const mutuallyVisibleFriend = (id: string) =>
        Effect.gen(function* resolveMutualVisibility() {
          const caller = yield* SetCaller;
          const target = yield* visibleFriend(id);
          const { people } = readTrustRegistry(trustPath).store;
          yield* Effect.try({
            catch: (error) =>
              error instanceof LibraryError ? error : missingPlaylist(),
            try: () =>
              resolveVisiblePerson(people, target.id, caller.person.id),
          });
          return target;
        });
      const ownedPlaylist = (id: string, personId: string) =>
        Effect.gen(function* findOwnedPlaylist() {
          const [row] = yield* db
            .select({
              collaborative: playlists.collaborative,
              id: playlists.id,
            })
            .from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.creatorId, personId)))
            .limit(1);
          if (!row) {
            return yield* Effect.fail(missingPlaylist());
          }
          return row;
        });
      const collaborationFor = (id: string, personId: string) =>
        Effect.gen(function* readCollaboration() {
          const playlist = yield* ownedPlaylist(id, personId);
          const editors = yield* db
            .select({ editorId: playlistEditors.editorId })
            .from(playlistEditors)
            .where(eq(playlistEditors.playlistId, id));
          return {
            collaborative: playlist.collaborative,
            editorIds: editors.map((row) => row.editorId),
          };
        });
      const editablePlaylistOwner = (id: string, personId: string) =>
        resolveEditablePlaylist({
          id,
          people: readTrustRegistry(trustPath).store.people,
          personId,
        }).pipe(Effect.provideService(Database, db));
      const personSummary = (id: string) => {
        const { people } = readTrustRegistry(trustPath).store;
        const person = people.find((candidate) => candidate.id === id);
        return { id, username: person?.username ?? id };
      };
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
            .handle("shared", () =>
              withFailureResponse(
                Effect.gen(function* listSharedPlaylists() {
                  const caller = yield* SetCaller;
                  const rows = yield* db
                    .select({
                      createdAt: playlists.createdAt,
                      creatorId: playlists.creatorId,
                      id: playlists.id,
                      name: playlists.name,
                      setCount: sql<number>`(
                        SELECT COUNT(*)
                        FROM ${playlistSets}
                        WHERE ${playlistSets.playlistId} = ${playlists.id}
                      )`,
                    })
                    .from(playlistEditors)
                    .innerJoin(
                      playlists,
                      eq(playlists.id, playlistEditors.playlistId)
                    )
                    .where(
                      and(
                        eq(playlistEditors.editorId, caller.person.id),
                        eq(playlists.creatorId, playlistEditors.creatorId),
                        eq(playlists.collaborative, true)
                      )
                    )
                    .orderBy(asc(sql`${playlists.name} COLLATE NOCASE`));
                  const shared = [];
                  for (const { creatorId, ...playlist } of rows) {
                    const open = yield* Effect.option(
                      mutuallyVisibleFriend(creatorId)
                    );
                    if (Option.isSome(open)) {
                      shared.push({
                        ...playlist,
                        creator: personSummary(creatorId),
                      });
                    }
                  }
                  return { playlists: shared };
                })
              )
            )
            .handle("read", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* readPlaylist() {
                  const caller = yield* SetCaller;
                  const ownerId = yield* editablePlaylistOwner(
                    params.id,
                    caller.person.id
                  );
                  const [playlist] = yield* db
                    .select({
                      createdAt: playlists.createdAt,
                      id: playlists.id,
                      name: playlists.name,
                    })
                    .from(playlists)
                    .where(eq(playlists.id, params.id))
                    .limit(1);
                  if (!playlist) {
                    return yield* Effect.fail(missingPlaylist());
                  }
                  const members = yield* Effect.provide(
                    Effect.gen(function* listPlaylistMembers() {
                      const ownerLibrary = yield* Library;
                      return yield* ownerLibrary.list({
                        playlistId: params.id,
                      });
                    }),
                    libraryFor(ownerId)
                  );
                  const role: "creator" | "editor" =
                    ownerId === caller.person.id ? "creator" : "editor";
                  return {
                    ...playlist,
                    creator: personSummary(ownerId),
                    role,
                    setCount: members.length,
                    sets: members,
                  };
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
                  const caller = yield* SetCaller;
                  const ownerId = yield* editablePlaylistOwner(
                    params.id,
                    caller.person.id
                  );
                  const personal = yield* Library;
                  if (ownerId !== caller.person.id) {
                    const visible = yield* personal.byIds(input.setIds);
                    if (visible.length !== input.setIds.length) {
                      return yield* Effect.fail(
                        new LibraryError({
                          message: "Set not found.",
                          statusCode: 404,
                        })
                      );
                    }
                    const ownerLayer = libraryFor(ownerId);
                    return {
                      sets: yield* Effect.provide(
                        Effect.gen(function* updateSharedPlaylist() {
                          const ownerLibrary = yield* Library;
                          return yield* ownerLibrary.setPlaylistMembers(
                            params.id,
                            input.setIds
                          );
                        }),
                        ownerLayer
                      ),
                    };
                  }
                  return {
                    sets: yield* personal.setPlaylistMembers(
                      params.id,
                      input.setIds
                    ),
                  };
                })
              )
            )
            .handle("collaboration", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* readPlaylistCollaboration() {
                  const caller = yield* SetCaller;
                  return yield* collaborationFor(params.id, caller.person.id);
                })
              )
            )
            .handleRaw("setCollaboration", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* changePlaylistCollaboration() {
                  const caller = yield* SetCaller;
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      CollaborationPayload
                    );
                  yield* ownedPlaylist(params.id, caller.person.id);
                  yield* journal.transaction((tx) =>
                    journal
                      .changingAccess(
                        tx,
                        tx
                          .update(playlists)
                          .set({ collaborative: input.collaborative })
                          .where(
                            and(
                              eq(playlists.id, params.id),
                              eq(playlists.creatorId, caller.person.id)
                            )
                          )
                      )
                      .pipe(
                        Effect.andThen(
                          journal.record(tx, {
                            playlistId: params.id,
                            topic: "playlist",
                          })
                        )
                      )
                  );
                  return yield* collaborationFor(params.id, caller.person.id);
                })
              )
            )
            .handleRaw("setEditors", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* setPlaylistEditors() {
                  const caller = yield* SetCaller;
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    PlaylistEditorsPayload
                  );
                  yield* ownedPlaylist(params.id, caller.person.id);
                  if (
                    new Set(input.editorIds).size !== input.editorIds.length
                  ) {
                    return yield* Effect.fail(
                      new LibraryError({
                        message: "An editor can only appear once.",
                        statusCode: 400,
                      })
                    );
                  }
                  for (const editorId of input.editorIds) {
                    yield* mutuallyVisibleFriend(editorId);
                  }
                  yield* journal.transaction((tx) =>
                    Effect.gen(function* replaceEditors() {
                      yield* journal.changingAccess(
                        tx,
                        Effect.gen(function* writeEditors() {
                          yield* tx
                            .delete(playlistEditors)
                            .where(eq(playlistEditors.playlistId, params.id));
                          if (input.editorIds.length > 0) {
                            yield* tx.insert(playlistEditors).values(
                              input.editorIds.map((editorId) => ({
                                creatorId: caller.person.id,
                                editorId,
                                playlistId: params.id,
                              }))
                            );
                          }
                        })
                      );
                      yield* journal.record(tx, {
                        playlistId: params.id,
                        topic: "playlist",
                      });
                    })
                  );
                  return yield* collaborationFor(params.id, caller.person.id);
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
                const caller = yield* SetCaller;
                const creatorId = yield* editablePlaylistOwner(
                  input.playlistId,
                  caller.person.id
                );
                const queue = yield* Queue;
                return {
                  queue: yield* queue.replaceWithPlaylist(
                    input.playlistId,
                    creatorId
                  ),
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
                  const caller = yield* SetCaller;
                  const personal = yield* Library;
                  const saved = yield* personal.setPlaybackPosition(
                    params.id,
                    input.seconds
                  );
                  if (caller.keyId !== null && caller.scope === "daily") {
                    yield* presence.recordLegacyReport(
                      { keyId: caller.keyId, personId: caller.person.id },
                      params.id
                    );
                  }
                  return saved;
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
      const friendLibraryLayer = (personId: string) => libraryFor(personId, {});
      const presenceFor = (viewerId: string) =>
        visiblePresence({
          libraryFor: friendLibraryLayer,
          now: Date.now(),
          people: readTrustRegistry(trustPath).store.people,
          presence,
          viewerId,
        });
      feedReader = makeFeed({
        db,
        friendLibraryFor: friendLibraryLayer,
        libraryFor: (personId) => libraryFor(personId),
        presence,
        retentionMs: options.feed?.retentionMs,
      });
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
                const updated = yield* trustWrite((tx) =>
                  journal.changingAccess(
                    tx,
                    updatePerson(tx, caller.person.id, input)
                  )
                );
                return HttpServerResponse.jsonUnsafe(updated);
              })
            )
          )
          .handleRaw("list", () =>
            withFailureResponse(
              Effect.gen(function* listVisiblePeople() {
                const caller = yield* SetCaller;
                const { people } = readTrustRegistry(trustPath).store;
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
          .handleRaw("socialFilters", () =>
            withFailureResponse(
              Effect.gen(function* listSocialFilters() {
                const caller = yield* SetCaller;
                const { people } = readTrustRegistry(trustPath).store;
                return {
                  people: listFilterablePeople(people, caller.person.id),
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
                return yield* trustWrite((tx) =>
                  journal.changingAccess(
                    tx,
                    updatePersonFilters(tx, caller.person.id, params.id, input)
                  )
                );
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
                const friendPlaylists = yield* Effect.provide(
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
                return { playlists: friendPlaylists };
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
      const trustCall = <A>(action: (storePath: string) => A) =>
        Effect.tryPromise({
          catch: (error) =>
            new LibraryError({
              message:
                error instanceof AdminError
                  ? error.message
                  : "The trust store is unavailable.",
              statusCode: error instanceof AdminError ? error.statusCode : 500,
            }),
          try: () =>
            retryTrustOperation(() => {
              if (!trustPath) {
                throw new AdminError(500, "The trust store is unavailable.");
              }
              return action(trustPath);
            }),
        });
      const adminCall = <A>(action: (storePath: string) => A) =>
        Effect.andThen(requireAdminScope, trustCall(action));
      // Devices act for the Person behind a daily key. The local listener has
      // no key and an admin key is not a device, so both are refused.
      const deviceCall = <A>(
        action: (storePath: string, personId: string, keyId: string) => A
      ) =>
        Effect.gen(function* authorizedDeviceAction() {
          const caller = yield* SetCaller;
          const { keyId } = caller;
          if (keyId === null || caller.scope !== "daily") {
            return yield* new LibraryError({
              message: "Sign in with a device key.",
              statusCode: 403,
            });
          }
          return yield* trustCall((storePath) =>
            action(storePath, caller.person.id, keyId)
          );
        });
      // A key leaves with its Presence and its open feeds in one commit.
      const revokeKeyNow = (id: string, ownerId?: string) =>
        trustWrite((tx) =>
          Effect.gen(function* revokeWithPresence() {
            const key = yield* revokeKey(tx, id, ownerId);
            yield* presence.revokeKey(tx, key.id, key.personId);
            yield* journal.record(tx, { keyId: key.id, topic: "revoked" });
            return key;
          })
        ).pipe(Effect.tap(() => presence.afterCommit()));
      const devicesGroup = HttpApiBuilder.group(
        OrbisApi,
        "devices",
        (handlers) =>
          handlers
            .handleRaw("list", () =>
              withFailureResponse(
                Effect.map(deviceCall(listDevices), (devices) => ({ devices }))
              )
            )
            .handleRaw("revoke", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* revokeOwnDevice() {
                  const caller = yield* SetCaller;
                  if (caller.keyId === null || caller.scope !== "daily") {
                    return yield* new LibraryError({
                      message: "Sign in with a device key.",
                      statusCode: 403,
                    });
                  }
                  const key = yield* revokeKeyNow(params.id, caller.person.id);
                  return {
                    addedAt: key.addedAt,
                    current: key.id === caller.keyId,
                    id: key.id,
                    label: key.label,
                    lastUsedAt: key.lastUsedAt,
                  };
                })
              )
            )
      );
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
                yield* requireAdminScope;
                const released = yield* db
                  .all<{ readonly id: string }>(sql`
                  SELECT set_id AS id FROM library_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM queue_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM playlist_sets INNER JOIN playlists ON playlists.id = playlist_sets.playlist_id WHERE creator_id = ${params.id}
                `)
                  .pipe(Effect.orDie);
                const person = yield* trustWrite((tx) =>
                  journal.changingAccess(
                    tx,
                    Effect.gen(function* deleteAdminPersonRows() {
                      const removed = yield* removePerson(tx, params.id);
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
                      yield* presence.removePerson(tx, params.id);
                      for (const keyId of removed.keyIds) {
                        yield* journal.record(tx, { keyId, topic: "revoked" });
                      }
                      return removed.person;
                    })
                  )
                );
                yield* presence.afterCommit();
                yield* Effect.forEach((set: { readonly id: string }) =>
                  library.release(set.id)
                )(released);
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
              Effect.andThen(requireAdminScope, revokeKeyNow(params.id))
            )
          )
          .handleRaw("createInvite", ({ params }) =>
            withFailureResponse(
              Effect.map(
                adminCall((storePath) =>
                  createInvite(storePath, params.id, {
                    now: Date.now(),
                    ttlMs: options.inviteTtlMs ?? INVITE_TTL_MS,
                  })
                ),
                (invite) =>
                  HttpServerResponse.jsonUnsafe(invite, { status: 201 })
              )
            )
          )
      );
      // An Invite mints only a daily key, for the Person it names (ADR 0016).
      // The code is spent before the key exists, so it yields one key.
      const inviteGroup = HttpApiBuilder.group(
        OrbisApi,
        "invites",
        (handlers) =>
          handlers.handleRaw("claim", () =>
            withFailureResponse(
              Effect.gen(function* claimInvite() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(InviteClaimPayload);
                const label = input.label.trim();
                if (label === "") {
                  return yield* new LibraryError({
                    message: "Name this device.",
                    statusCode: 400,
                  });
                }
                const claim = yield* trustCall((storePath) =>
                  consumeInvite(storePath, input.code, Date.now())
                );
                if (claim.kind !== "found") {
                  return yield* new LibraryError(INVITE_FAILURES[claim.kind]);
                }
                const { personId } = claim;
                const key = yield* trustCall((storePath) =>
                  addKey(storePath, personId, { label, scope: "daily" })
                );
                const person = readTrustRegistry(trustPath).store.people.find(
                  (candidate) => candidate.id === personId
                );
                return HttpServerResponse.jsonUnsafe({
                  key: key.token,
                  person: { id: personId, username: person?.username ?? "" },
                });
              })
            )
          )
      );
      const eventsGroup = HttpApiBuilder.group(OrbisApi, "events", (handlers) =>
        handlers.handle("subscribe", () =>
          Effect.gen(function* subscribeEvents() {
            const queue = yield* Queue;
            const caller = yield* SetCaller;
            const authorized = () => {
              if (caller.keyId === null) {
                return true;
              }
              const { store } = readTrustRegistry(trustPath);
              return (
                store.keys.some(
                  (key) =>
                    key.id === caller.keyId && key.personId === caller.person.id
                ) &&
                store.people.some(
                  (person) => person.id === caller.person.id && !person.removed
                )
              );
            };
            const snapshots = queue.changes.pipe(
              Stream.mapEffect(() => queue.read()),
              Stream.map((snapshot) => ({
                kind: "queue" as const,
                queue: snapshot,
              }))
            );
            const presenceFrames = Stream.merge(
              Stream.tick("2 seconds"),
              presence.changes
            ).pipe(
              Stream.mapEffect(() => presenceFor(caller.person.id)),
              Stream.changesWith(
                (left, right) => JSON.stringify(left) === JSON.stringify(right)
              ),
              Stream.map((found) => ({
                kind: "presence" as const,
                presence: found,
              }))
            );
            const heartbeats = Stream.tick("30 seconds").pipe(
              Stream.drop(1),
              Stream.map(() => ({ kind: "heartbeat" as const }))
            );
            return Stream.merge(
              Stream.merge(snapshots, presenceFrames),
              heartbeats
            ).pipe(Stream.takeWhile(authorized), Stream.orDie);
          })
        )
      );
      const presenceGroup = HttpApiBuilder.group(
        OrbisApi,
        "presence",
        (handlers) =>
          handlers.handleRaw("act", () =>
            withFailureResponse(
              Effect.gen(function* actOnPresence() {
                const caller = yield* SetCaller;
                const { keyId } = caller;
                if (keyId === null || caller.scope !== "daily") {
                  return yield* new LibraryError({
                    message: "Sign in with a device key.",
                    statusCode: 403,
                  });
                }
                const input = yield* HttpServerRequest.schemaBodyJson(
                  PresenceActionPayload
                );
                if (input.kind === "play") {
                  const personal = yield* Library;
                  const [set] = yield* personal.byIds([input.setId]);
                  if (!set) {
                    return yield* new LibraryError({
                      message: "Set not found.",
                      statusCode: 404,
                    });
                  }
                }
                return yield* presence
                  .act({ keyId, personId: caller.person.id }, input)
                  .pipe(
                    Effect.catchTag("PresenceConflict", (refusal) =>
                      Effect.succeed(
                        HttpServerResponse.jsonUnsafe(
                          { message: refusal.message, reason: refusal.reason },
                          { status: 409 }
                        )
                      )
                    )
                  );
              })
            )
          )
      );
      // Device Links mint only daily keys, for the Person who approved (ADR 0016).
      const mintLinkedKey = (personId: string, label: string) =>
        Effect.tryPromise({
          catch: (error) =>
            new LibraryError({
              message:
                error instanceof AdminError
                  ? "No device is waiting with that code."
                  : "The trust store is unavailable.",
              statusCode: error instanceof AdminError ? 404 : 500,
            }),
          try: () =>
            retryTrustOperation(() => {
              if (!trustPath) {
                throw new Error("The trust store is unavailable.");
              }
              const key = addKey(trustPath, personId, {
                label,
                scope: "daily",
              });
              const person = readTrustRegistry(trustPath).store.people.find(
                (candidate) => candidate.id === personId
              );
              return {
                key: key.token,
                person: { id: personId, username: person?.username ?? "" },
                status: "approved" as const,
              };
            }),
        });
      const deviceLinkGroup = HttpApiBuilder.group(
        OrbisApi,
        "deviceLinks",
        (handlers) =>
          handlers
            .handleRaw("start", () =>
              withFailureResponse(
                Effect.gen(function* startDeviceLink() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    DeviceLinkStartPayload
                  );
                  const label = input.label.trim();
                  if (label === "") {
                    return yield* new LibraryError({
                      message: "Name this device.",
                      statusCode: 400,
                    });
                  }
                  const started = deviceLinks.start(label);
                  if (!started) {
                    return yield* new LibraryError({
                      message: "Too many devices are waiting. Try again soon.",
                      statusCode: 503,
                    });
                  }
                  return HttpServerResponse.jsonUnsafe(
                    {
                      expiresAt: new Date(started.expiresAt).toISOString(),
                      pollSecret: started.pollSecret,
                      userCode: started.userCode,
                    },
                    { status: 201 }
                  );
                })
              )
            )
            .handleRaw("poll", () =>
              withFailureResponse(
                Effect.gen(function* pollDeviceLink() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    DeviceLinkPollPayload
                  );
                  const result = deviceLinks.poll(input.pollSecret);
                  if (result.kind === "missing") {
                    return yield* linkFailure("missing");
                  }
                  if (result.kind !== "approved") {
                    return HttpServerResponse.jsonUnsafe({
                      status: result.kind,
                    });
                  }
                  return HttpServerResponse.jsonUnsafe(
                    yield* mintLinkedKey(result.personId, result.label)
                  );
                })
              )
            )
            .handleRaw("lookup", () =>
              withFailureResponse(
                Effect.gen(function* lookupDeviceLink() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    DeviceLinkCodePayload
                  );
                  const found = deviceLinks.lookup(input.userCode);
                  if (found.kind !== "found") {
                    return yield* linkFailure(found.kind);
                  }
                  return HttpServerResponse.jsonUnsafe(
                    linkBody(found.label, found.expiresAt)
                  );
                })
              )
            )
            .handleRaw("approve", () =>
              withFailureResponse(
                Effect.gen(function* approveDeviceLink() {
                  const { person } = yield* SetCaller;
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    DeviceLinkCodePayload
                  );
                  const found = deviceLinks.approve(input.userCode, person.id);
                  if (found.kind !== "found") {
                    return yield* linkFailure(found.kind);
                  }
                  return HttpServerResponse.jsonUnsafe(
                    linkBody(found.label, found.expiresAt)
                  );
                })
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
          Layer.provide(deviceLinkGroup),
          Layer.provide(inviteGroup),
          Layer.provide(eventsGroup),
          Layer.provide(presenceGroup),
          Layer.provide(peopleGroup),
          Layer.provide(adminGroup),
          Layer.provide(devicesGroup),
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
                      const personalLibrary = libraryFor(access.person.id);
                      const personalQueue = Queue.forPersonLayer(
                        access.person.id
                      ).pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            services,
                            Layer.succeed(QueueSignals, signals),
                            Layer.succeed(Presence, presence),
                            personalLibrary,
                            Stats.forPersonLayer(access.person.id).pipe(
                              Layer.provide(services)
                            )
                          )
                        )
                      );
                      return Effect.provide(
                        Effect.provideService(
                          Effect.gen(function* callerRequest() {
                            const request =
                              yield* HttpServerRequest.HttpServerRequest;
                            if (
                              request.headers["x-orbis-ingress"] ===
                              "funnel-forward"
                            ) {
                              const key = readTrustRegistry(
                                trustPath
                              ).store.keys.find(
                                (record) => record.id === access.keyId
                              );
                              yield* annotateForwardedRequest(
                                key?.label ?? null
                              );
                            }
                            return yield* effect;
                          }),
                          SetCaller,
                          access
                        ),
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
      Layer.provide(options.audio),
      Layer.provide(libraryLayer),
      Layer.provide(presenceLayer),
      Layer.provide(journalLayer),
      Layer.provide(queueSignalsLayer),
      Layer.provide(options.metadata ?? Metadata.unconfigured()),
      Layer.provide(options.titleReviser ?? TitleReviser.unconfigured()),
      Layer.provide(options.versos ?? Versos.unconfigured()),
      Layer.provide(database),
      Layer.provide(loggingLayer)
    ),
    {
      disableLogger: true,
      middleware: makeRequestLogMiddleware(options.logging),
    }
  );
  /**
   * A start always counts toward the failed-key limit, and so does a poll whose
   * secret matches no link. A poll of a live link does not, so a device waiting for
   * approval is never limited. A failed Invite claim counts too. A client over the
   * limit is refused before any lookup, so it cannot spend an Invite.
   */
  const openRoute = async (
    request: Request,
    mode: AccessMode,
    client: string,
    pathname: string
  ): Promise<Response> => {
    const limited = mode === "device";
    if (limited && overFailedKeyLimit(client)) {
      return tooManyAttempts();
    }
    if (limited && pathname === "/device-links" && recordFailedKey(client)) {
      return tooManyAttempts();
    }
    // SAFETY: the open Device Link and Invite handlers read no caller-bound service.
    const response = await app.handler(
      request,
      Context.empty() as Context.Context<Library | Queue | SetCaller>
    );
    const failedGuess =
      (pathname === "/device-links/poll" &&
        (response.status === 404 || response.status === 400)) ||
      (pathname === INVITE_CLAIM_ROUTE &&
        [400, 404, 409, 410].includes(response.status));
    if (limited && failedGuess && recordFailedKey(client)) {
      return tooManyAttempts();
    }
    return response;
  };
  const initialize = () =>
    // SAFETY: The health route reads no caller-bound service.
    app.handler(
      new Request("http://orbis.internal/health"),
      Context.empty() as Context.Context<Library | Queue | SetCaller>
    );
  // oxlint-disable-next-line eslint/sort-keys -- Lifecycle methods precede the request boundary.
  return {
    dispose: app.dispose,
    initialize,
    expirePresence: async (): Promise<void> => {
      await initialize();
      if (presenceService) {
        await Effect.runPromise(presenceService.expire(Date.now()));
      }
    },
    /** The catch-up operation and commit notices the feed transport (#211) adapts. */
    feed: {
      authorize: async (keyId: string) => {
        await initialize();
        if (!feedReader) {
          throw new Error("The feed is not ready.");
        }
        return Effect.runPromise(feedReader.authorize(keyId));
      },
      catchUp: async (request: {
        readonly keyId: string;
        readonly cursor: string | null;
      }): Promise<CatchUp> => {
        await initialize();
        if (!feedReader) {
          throw new Error("The feed is not ready.");
        }
        return Effect.runPromise(feedReader.catchUp(request));
      },
      subscribe: (listener: (notice: FeedNotice) => void) =>
        feedSignals.subscribe(listener),
    },
    handler: async (
      request: Request,
      mode: AccessMode,
      clientAddress = "unknown"
    ): Promise<Response> => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Kept at the boundary that owns stream headers.
      const withOrigin = (response: Response): Response => {
        if (
          response.headers.get("content-type")?.startsWith("text/event-stream")
        ) {
          response.headers.set("cache-control", "no-cache, no-transform");
          response.headers.set("x-accel-buffering", "no");
        }
        return response;
      };
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const authorization = request.headers.get("authorization");
      const { pathname } = new URL(request.url);
      if (
        request.method === "POST" &&
        (pathname === INVITE_CLAIM_ROUTE ||
          (authorization === null && OPEN_ROUTES.has(pathname)))
      ) {
        return openRoute(request, mode, clientAddress, pathname).then(
          withOrigin
        );
      }
      const registry = readTrustRegistry(trustPath);
      const streamDecision = grantAccess(
        request,
        mode,
        registry.store,
        streamSecret
      );
      if (rejectedStreamGrant(request, streamDecision)) {
        return withOrigin(
          Response.json({ message: "Invalid stream grant." }, { status: 401 })
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
        decision.statusCode === 401 &&
        recordFailedKey(clientAddress)
      ) {
        return withOrigin(tooManyAttempts());
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
        return withOrigin(
          Response.json(
            { message: decision.message },
            { status: decision.statusCode }
          )
        );
      }
      if (options.recordKeyUse !== false) {
        await retryTrustOperation(() =>
          markKeyUsed(trustPath, decision.keyId)
        ).catch(() => null);
      }
      // SAFETY: SetAccess provides the caller-bound Library and Queue before handlers read them.
      const response = await app.handler(
        request,
        Context.add(
          Context.make(SetCaller, decision),
          AcceptedAccess,
          decision
        ) as Context.Context<Library | Queue | SetCaller>
      );
      return withOrigin(
        forwardedResponse(request, response, registry.store, decision.keyId)
      );
    },
  };
};
