import type { SavedSet } from "@orbis/contracts";
import type {
  ChangeTopic,
  SaveSetResultSchema,
} from "@orbis/contracts/http-api";
import {
  AdminKeyPayload,
  AdminPersonPayload,
  CollaborationPayload,
  JoinPayload,
  RedeemSignInCodePayload,
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
import {
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Scope,
  Stream,
} from "effect";
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
  issueSignInCode,
  joinGroup,
  listDevices,
  listKeys,
  listPeople,
  closeJoining,
  newPasscode,
  readPasscode,
  redeemSignInCode,
  removePerson,
  revokeDevice,
  revokeKey,
} from "./admin.js";
import { makeAttemptLimiter } from "./attempt-limiter.js";
import { Audio } from "./audio-service.js";
import type { AudioFile } from "./audio-service.js";
import { insertBatches } from "./db/batches.js";
import {
  listens,
  playlistEditors,
  playlistSets,
  playlists,
  sets as setRows,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type {
  AccessDecision,
  AccessMode,
  PersonRecord,
  TrustStore,
} from "./identity.js";
import {
  decideAccess,
  HOST_PERSON_ID,
  markKeyUsed,
  readTrustRegistry,
  updatePerson,
  updatePersonFilters,
} from "./identity.js";
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
  withWideEvent,
} from "./logging.js";
import type { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import type { EnrichedMetadata } from "./metadata.js";
import { PresenceJournal } from "./presence-journal.js";
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
import { trustOperation } from "./trust-storage.js";
import { Versos } from "./versos.js";
import {
  listFilterablePeople,
  resolveVisiblePerson,
  resolveVisibleSet,
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
    ? { keyId: null, kind: "accepted", person }
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

const ownDevices = (personId: string) => (viewerId: string) =>
  Effect.succeed(viewerId === personId);

const meBody = (person: PersonRecord) => ({
  autoDownload: person.autoDownload ?? true,
  host: person.id === HOST_PERSON_ID,
  id: person.id,
  social: person.social ?? false,
  username: person.username,
});

const PRESENCE_WINDOW_MS = 30_000;
const tooManyAttempts = () =>
  Response.json({ message: "Too many invalid keys." }, { status: 429 });
/**
 * Routes a new device calls before it has a key (ADR 0020). They run whatever
 * the Authorization header says, so a key cannot skip the failed-key limit.
 */
const OPEN_ROUTES: ReadonlySet<string> = new Set([
  "/sign-in/code",
  "/sign-in/join",
]);
/**
 * The router also matches a path with repeated or trailing slashes, other
 * casing, or percent-encoding, so the open-route lookup sees the same
 * spelling the router does. Otherwise a guess on `/sign-in/code/` would run
 * without being counted.
 */
const isOpenRoute = (url: string): boolean => {
  const raw = new URL(url).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const pathname = decoded
    .toLowerCase()
    .replaceAll(/\/+/gu, "/")
    .replace(/(?<=.)\/$/u, "");
  return OPEN_ROUTES.has(pathname);
};
const invalidSignInCode = () =>
  new LibraryError({
    message: "That code is not valid. Get a new one.",
    statusCode: 404,
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

const trustUnavailable = () =>
  new LibraryError({
    message: "The trust store is unavailable.",
    statusCode: 500,
  });

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
  presence?: PresenceOptions & { journal?: Layer.Layer<PresenceJournal> };
  /** The clock Sign-in Codes expire by. Tests move it to prove expiry. */
  signInCodeNow?: () => number;
  /** Follows short links such as `on.soundcloud.com`. Tests pass a stub to stay offline. */
  shortLinkFetch?: (url: string, signal: AbortSignal) => Promise<Response>;
  titleReviser?: Layer.Layer<TitleReviser>;
  versos?: Layer.Layer<Versos>;
}) => {
  configureLogging(options.logging);
  const { trustPath } = options;
  const { streamSecret } = options;
  const attempts = makeAttemptLimiter();
  const signInCodeNow = options.signInCodeNow ?? Date.now;
  const { database } = options;
  const libraryOptions = {
    people: () => readTrustRegistry(trustPath).store.people,
    releaseAudio: options.releaseAudio,
  };
  const libraryLayer = Library.forPersonLayer("host", libraryOptions).pipe(
    Layer.provide(database)
  );
  const queueSignalsLayer = QueueSignals.layer;
  const presenceLayer = Presence.layer({
    ...options.presence,
    legacyReportWindowMs: options.presenceWindowMs ?? PRESENCE_WINDOW_MS,
  }).pipe(
    Layer.provide(database),
    Layer.provide(options.presence?.journal ?? PresenceJournal.unrecorded)
  );
  let presenceService: typeof Presence.Service | null = null;
  const routes = Layer.effectDiscard(
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const db = yield* Database;
      const presence = yield* Presence;
      presenceService = presence;
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
      const versos = yield* Versos;
      const scope = yield* Scope.Scope;
      const signals = yield* QueueSignals;
      // Every open `/events` stream reads this hub. A `changed` entry decides its own
      // recipients when delivered; `access` makes each stream recheck its key.
      const changes = yield* PubSub.unbounded<
        | {
            readonly kind: "changed";
            readonly topic: ChangeTopic;
            readonly reaches: (viewerId: string) => Effect.Effect<boolean>;
          }
        | { readonly kind: "access" }
      >();
      const announce = (
        topic: ChangeTopic,
        reaches: (viewerId: string) => Effect.Effect<boolean>
      ) => PubSub.publish(changes, { kind: "changed", reaches, topic });
      const recheckAccess = () => PubSub.publish(changes, { kind: "access" });
      const seesPerson = (personId: string) => (viewerId: string) =>
        Effect.sync(() => {
          if (viewerId === personId) {
            return true;
          }
          try {
            resolveVisiblePerson(
              readTrustRegistry(trustPath).store.people,
              viewerId,
              personId
            );
            return true;
          } catch {
            return false;
          }
        });
      const readsSet = (setId: string) => (viewerId: string) =>
        resolveVisibleSet({
          id: setId,
          people: readTrustRegistry(trustPath).store.people,
          personId: viewerId,
        }).pipe(
          Effect.provideService(Database, db),
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );
      const announceForCaller = (
        topic: ChangeTopic,
        reaches: (
          personId: string
        ) => (viewerId: string) => Effect.Effect<boolean>
      ) =>
        Effect.gen(function* announceCallerChange() {
          const caller = yield* SetCaller;
          yield* announce(topic, reaches(caller.person.id));
        });
      const runningTracklists = new Set<string>();
      const startTracklist = Effect.fn("SaveSet.startTracklist")(
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
                withWideEvent({ job: "tracklist", set: id }, options.logging),
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
      const reviseTitle = Effect.fn("SaveSet.reviseTitle")((
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
      const fillDetails = Effect.fn("SaveSet.fillDetails")((set: SavedSet) =>
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
                      library.recordDetailsFailure(set.id).pipe(
                        Effect.ignore({
                          log: "Warn",
                          message: "set details failure not recorded",
                        })
                      )
                    )
                  ),
          }),
          withWideEvent({ job: "set-details", set: set.id }, options.logging),
          Effect.forkIn(scope),
          Effect.asVoid
        )
      );
      // Enrichment failure is swallowed so the save still succeeds, so it is the
      // one outcome a client cannot see. The log records which set and which reason.
      const enrichSavedSet = Effect.fn("SaveSet.enrich")((
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
              }).pipe(
                Effect.tap(() => announce("set", readsSet(params.id))),
                Effect.tapError(logLibraryFailure)
              ),
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
              }).pipe(Effect.tap(() => announce("set", readsSet(params.id))))
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
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
            )
          )
          .handle("retryMetadata", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* retrySetMetadata() {
                const personal = yield* Library;
                const set = yield* personal.find(params.id);
                return yield* enrichSavedSet(set, personal);
              }).pipe(Effect.tap(() => announce("set", readsSet(params.id))))
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
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
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
              }).pipe(
                Effect.tap(() => announceForCaller("library", ownDevices))
              )
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
        Effect.gen(function* resolveEditablePlaylist() {
          const [owned] = yield* db
            .select({ id: playlists.id })
            .from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.creatorId, personId)))
            .limit(1);
          if (owned) {
            return personId;
          }
          const [editor] = yield* db
            .select({ creatorId: playlistEditors.creatorId })
            .from(playlistEditors)
            .where(
              and(
                eq(playlistEditors.playlistId, id),
                eq(playlistEditors.editorId, personId)
              )
            )
            .limit(1);
          if (!editor) {
            return yield* Effect.fail(missingPlaylist());
          }
          yield* mutuallyVisibleFriend(editor.creatorId);
          const [playlist] = yield* db
            .select({ collaborative: playlists.collaborative })
            .from(playlists)
            .where(
              and(
                eq(playlists.id, id),
                eq(playlists.creatorId, editor.creatorId)
              )
            )
            .limit(1);
          if (!playlist?.collaborative) {
            return yield* Effect.fail(missingPlaylist());
          }
          return editor.creatorId;
        });
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
                    Library.forPersonLayer(ownerId, libraryOptions).pipe(
                      Layer.provide(Layer.succeed(Database, db))
                    )
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
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
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
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
              )
            )
            .handle("remove", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* removePersonalPlaylist() {
                  const personal = yield* Library;
                  return yield* personal.deletePlaylist(params.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
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
                    const ownerLayer = Library.forPersonLayer(
                      ownerId,
                      libraryOptions
                    ).pipe(Layer.provide(Layer.succeed(Database, db)));
                    const sets = yield* Effect.provide(
                      Effect.gen(function* updateSharedPlaylist() {
                        const ownerLibrary = yield* Library;
                        return yield* ownerLibrary.setPlaylistMembers(
                          params.id,
                          input.setIds
                        );
                      }),
                      ownerLayer
                    );
                    yield* announce("playlist", seesPerson(ownerId));
                    return { sets };
                  }
                  const sets = yield* personal.setPlaylistMembers(
                    params.id,
                    input.setIds
                  );
                  yield* announce("playlist", seesPerson(ownerId));
                  return { sets };
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
                  yield* db
                    .update(playlists)
                    .set({ collaborative: input.collaborative })
                    .where(
                      and(
                        eq(playlists.id, params.id),
                        eq(playlists.creatorId, caller.person.id)
                      )
                    );
                  return yield* collaborationFor(params.id, caller.person.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
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
                  yield* db.transaction((tx) =>
                    Effect.gen(function* replaceEditors() {
                      yield* tx
                        .delete(playlistEditors)
                        .where(eq(playlistEditors.playlistId, params.id));
                      const rows = input.editorIds.map((editorId) => ({
                        creatorId: caller.person.id,
                        editorId,
                        playlistId: params.id,
                      }));
                      for (const batch of insertBatches(
                        playlistEditors,
                        rows
                      )) {
                        yield* tx.insert(playlistEditors).values(batch);
                      }
                    })
                  );
                  return yield* collaborationFor(params.id, caller.person.id);
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
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
                }).pipe(
                  Effect.tap(() => announceForCaller("playlist", seesPerson))
                )
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
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
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
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
            )
          )
          .handleRaw("complete", () =>
            withFailureResponse(
              Effect.gen(function* completeQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
                const queue = yield* Queue;
                return { queue: yield* queue.complete(input.setId) };
              }).pipe(
                Effect.tap(() =>
                  announceForCaller("listen-history", seesPerson)
                )
              )
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
                  if (caller.keyId !== null) {
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
                }).pipe(
                  Effect.tap(() => announceForCaller("library", ownDevices))
                )
              )
            )
      );
      const friendLibraryLayer = (personId: string) =>
        Library.forPersonLayer(personId).pipe(
          Layer.provide(Layer.succeed(Database, db))
        );
      const presenceFor = (viewerId: string) =>
        Effect.gen(function* readPresence() {
          const { people } = readTrustRegistry(trustPath).store;
          const now = Date.now();
          const found = [];
          for (const person of people) {
            let target;
            try {
              target = resolveVisiblePerson(people, viewerId, person.id);
            } catch {
              continue;
            }
            const setId = yield* presence
              .currentSetFor(target.id, now)
              .pipe(Effect.orElseSucceed(() => null));
            if (setId === null) {
              continue;
            }
            const [set] = yield* Effect.provide(
              Effect.gen(function* hydratePresence() {
                const personal = yield* Library;
                return yield* personal.byIds([setId]);
              }),
              friendLibraryLayer(target.id)
            ).pipe(Effect.orElseSucceed(() => []));
            if (set) {
              found.push({
                personId: target.id,
                set,
                username: target.username,
              });
            }
          }
          return found;
        });
      const peopleGroup = HttpApiBuilder.group(OrbisApi, "people", (handlers) =>
        handlers
          .handle("me", () =>
            Effect.gen(function* readMe() {
              const { person } = yield* SetCaller;
              return meBody(person);
            })
          )
          .handleRaw("updateMe", () =>
            withFailureResponse(
              Effect.gen(function* updateMe() {
                const caller = yield* SetCaller;
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateMePayload);
                const result = yield* trustOperation(() =>
                  updatePerson(trustPath, caller.person.id, input)
                ).pipe(Effect.mapError(trustUnavailable));
                if (result.kind === "updated") {
                  return HttpServerResponse.jsonUnsafe(meBody(result.person));
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
                const result = yield* trustOperation(() =>
                  updatePersonFilters(
                    trustPath,
                    caller.person.id,
                    params.id,
                    input
                  )
                ).pipe(Effect.mapError(trustUnavailable));
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
      const requireHost = Effect.gen(function* verifyHost() {
        const caller = yield* SetCaller;
        if (caller.keyId === null || caller.person.id !== HOST_PERSON_ID) {
          return yield* new LibraryError({
            message: "Only the Host can do this.",
            statusCode: 403,
          });
        }
      });
      const trustCall = <A>(action: (storePath: string) => A) =>
        trustOperation(() => {
          if (!trustPath) {
            throw new AdminError(500, "The trust store is unavailable.");
          }
          return action(trustPath);
        }).pipe(
          Effect.mapError(
            ({ cause }) =>
              new LibraryError({
                message:
                  cause instanceof AdminError
                    ? cause.message
                    : "The trust store is unavailable.",
                statusCode:
                  cause instanceof AdminError ? cause.statusCode : 500,
              })
          )
        );
      const adminCall = <A>(action: (storePath: string) => A) =>
        Effect.andThen(requireHost, trustCall(action));
      const issueCodeFor = (personId: string) =>
        Effect.map(
          trustCall((storePath) =>
            issueSignInCode(storePath, personId, signInCodeNow())
          ),
          (issued) => HttpServerResponse.jsonUnsafe(issued, { status: 201 })
        );
      // Devices act for the Person behind a key. A stream grant has no key, so
      // it is refused.
      const deviceCall = <A>(
        action: (storePath: string, personId: string, keyId: string) => A
      ) =>
        Effect.gen(function* authorizedDeviceAction() {
          const caller = yield* SetCaller;
          const { keyId } = caller;
          if (keyId === null) {
            return yield* new LibraryError({
              message: "Sign in with a device key.",
              statusCode: 403,
            });
          }
          return yield* trustCall((storePath) =>
            action(storePath, caller.person.id, keyId)
          );
        });
      // The key is already gone, so a failed clear is logged: the next settle sweeps the
      // rows and the lease bounds how long the stale Presence can show.
      const clearRevokedPresence = (keyId: string) =>
        presence.revokeKey(keyId).pipe(
          Effect.catchTag("LibraryError", (failure) =>
            Effect.logWarning("revoked key presence not cleared").pipe(
              Effect.annotateLogs({ cause: failure.message })
            )
          ),
          Effect.andThen(recheckAccess())
        );
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
                deviceCall((storePath, personId, keyId) =>
                  revokeDevice(storePath, personId, keyId, params.id)
                ).pipe(Effect.tap(() => clearRevokedPresence(params.id)))
              )
            )
            .handleRaw("signInCode", () =>
              withFailureResponse(
                Effect.gen(function* issueOwnSignInCode() {
                  const { person } = yield* SetCaller;
                  return yield* issueCodeFor(person.id);
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
                yield* requireHost;
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
                const released = yield* db
                  .all<{ readonly id: string }>(sql`
                  SELECT set_id AS id FROM library_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM queue_entries WHERE person_id = ${params.id}
                  UNION SELECT set_id AS id FROM playlist_sets INNER JOIN playlists ON playlists.id = playlist_sets.playlist_id WHERE creator_id = ${params.id}
                `)
                  .pipe(Effect.orDie);
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
                      yield* presence.removePerson(tx, params.id);
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
                yield* presence.afterCommit();
                yield* recheckAccess();
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
                yield* requireHost;
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
              adminCall((storePath) => revokeKey(storePath, params.id)).pipe(
                Effect.tap(() => clearRevokedPresence(params.id))
              )
            )
          )
          .handleRaw("signInCodeFor", ({ params }) =>
            withFailureResponse(
              Effect.andThen(requireHost, issueCodeFor(params.id))
            )
          )
          .handleRaw("passcode", () =>
            withFailureResponse(adminCall(readPasscode))
          )
          .handleRaw("newPasscode", () =>
            withFailureResponse(adminCall(newPasscode))
          )
          .handleRaw("closeJoining", () =>
            withFailureResponse(adminCall(closeJoining))
          )
      );
      const signInGroup = HttpApiBuilder.group(OrbisApi, "signIn", (handlers) =>
        handlers
          .handleRaw("redeem", () =>
            withFailureResponse(
              Effect.gen(function* redeemCode() {
                const input = yield* HttpServerRequest.schemaBodyJson(
                  RedeemSignInCodePayload
                );
                const signedIn = yield* trustCall((storePath) =>
                  redeemSignInCode(storePath, input, signInCodeNow())
                );
                if (signedIn === null) {
                  return yield* invalidSignInCode();
                }
                return HttpServerResponse.jsonUnsafe(signedIn);
              })
            )
          )
          .handleRaw("join", () =>
            withFailureResponse(
              Effect.gen(function* joinWithPasscode() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(JoinPayload);
                const joined = yield* trustCall((storePath) =>
                  joinGroup(storePath, input)
                );
                return HttpServerResponse.jsonUnsafe(joined, { status: 201 });
              })
            )
          )
      );
      const eventsGroup = HttpApiBuilder.group(OrbisApi, "events", (handlers) =>
        handlers.handle("subscribe", ({ query }) =>
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
            // A null entry only makes `authorized` run, so a revoked key closes at once.
            const changeFrames = Stream.fromPubSub(changes).pipe(
              Stream.mapEffect((change) =>
                change.kind === "changed" && query.changes === "1"
                  ? Effect.map(change.reaches(caller.person.id), (reached) =>
                      reached
                        ? { kind: "changed" as const, topic: change.topic }
                        : null
                    )
                  : Effect.succeed(null)
              )
            );
            return Stream.merge(
              Stream.merge(snapshots, presenceFrames),
              Stream.merge(heartbeats, changeFrames)
            ).pipe(
              Stream.takeWhile(authorized),
              Stream.filter((frame) => frame !== null),
              Stream.orDie
            );
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
                if (keyId === null) {
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
          Layer.provide(signInGroup),
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
                      const personalLibrary = Library.forPersonLayer(
                        access.person.id,
                        libraryOptions
                      ).pipe(Layer.provide(Layer.succeed(Database, db)));
                      const personalQueue = Queue.forPersonLayer(
                        access.person.id
                      ).pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            Layer.succeed(Database, db),
                            Layer.succeed(QueueSignals, signals),
                            Layer.succeed(Presence, presence),
                            personalLibrary,
                            Stats.forPersonLayer(access.person.id).pipe(
                              Layer.provide(Layer.succeed(Database, db))
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
   * A sign-in attempt counts toward the failed-key limit before it runs. A
   * client over the limit is refused before any lookup, so it cannot spend a
   * code.
   */
  const openRoute = (request: Request, client: string): Promise<Response> => {
    if (attempts.signInAttempt(client)) {
      return Promise.resolve(tooManyAttempts());
    }
    // SAFETY: the sign-in handlers read no caller-bound service.
    return app.handler(
      request,
      Context.empty() as Context.Context<Library | Queue | SetCaller>
    );
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
      if (request.method === "POST" && isOpenRoute(request.url)) {
        return openRoute(request, clientAddress);
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
        attempts.badKey(clientAddress)
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
        await Effect.runPromise(
          trustOperation(() => markKeyUsed(trustPath, decision.keyId)).pipe(
            Effect.ignore
          )
        );
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
