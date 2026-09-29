import path from "node:path";

import type { SavedSet } from "@orbis/contracts";
import {
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
  TagsPayload,
  UpdateTitlePayload,
  UpdateMePayload,
} from "@orbis/contracts/http-api";
import { Context, Effect, Layer, Option, Schema, Scope } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { Audio } from "./audio.js";
import type { AudioFile, AudioOptions } from "./audio.js";
import { layer as databaseLayer } from "./db/database.js";
import { LibraryError } from "./errors.js";
import type { AccessDecision, AccessMode, TrustStore } from "./identity.js";
import {
  decideAccess,
  markKeyUsed,
  migrateTrustStore,
  readTrustRegistry,
  renamePerson,
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
  // The Database layer is one value used by every service that writes, so a build opens one
  // connection however many services depend on it. Queue composes the three below itself,
  // because it is the only service that needs the sets, the counters, and the queue at once.
  const libraryLayer = Library.layer.pipe(Layer.provide(database));
  const statsLayer = Stats.layer.pipe(Layer.provide(database));
  const queueLayer = Queue.layer.pipe(
    Layer.provide(Layer.mergeAll(database, libraryLayer, statsLayer))
  );
  const routes = Layer.effectDiscard(
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
      const queue = yield* Queue;
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
      const enrichSavedSet = Effect.fn("enrichSavedSet")((set: SavedSet) => {
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
          )
        );
      });
      const setGroup = HttpApiBuilder.group(OrbisApi, "sets", (handlers) =>
        handlers
          .handleRaw("requestDownload", ({ params }) =>
            Effect.match(
              audio
                .requestDownload(params.id)
                .pipe(Effect.tapError(logLibraryFailure)),
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
            withFailureResponse(audio.audioState(params.id))
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
            Effect.match(
              audio.audioFile(params.id).pipe(
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
            withFailureResponse(audio.cancelDownload(params.id))
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
                const saved = yield* library.save({
                  tags: [...(input.tags ?? [])],
                  title: input.title ?? "",
                  url,
                });
                yield* Effect.logInfo("set saved").pipe(
                  Effect.annotateLogs({ set: saved.id, source: saved.source })
                );
                if (saved.titleEditedByUser) {
                  yield* fillDetails(saved);
                  return saved;
                }
                return yield* enrichSavedSet(saved);
              })
            )
          )
          .handle("retryMetadata", ({ params }) =>
            withFailureResponse(
              library.find(params.id).pipe(Effect.flatMap(enrichSavedSet))
            )
          )
          .handleRaw("updateTitle", ({ params }) =>
            withFailureResponse(
              Effect.gen(function* updateSetTitle() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(UpdateTitlePayload);
                return yield* library.updateTitle(params.id, input.title);
              })
            )
          )
          .handle("remove", ({ params }) =>
            withFailureResponse(library.remove(params.id))
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
                const sets = yield* library.list({
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
                library
                  .playlists()
                  .pipe(Effect.map((playlists) => ({ playlists })))
              )
            )
            .handleRaw("create", () =>
              withFailureResponse(
                Effect.gen(function* createPlaylist() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(
                      PlaylistNamePayload
                    );
                  return yield* library.createPlaylist(input.name);
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
                  return yield* library.renamePlaylist(params.id, input.name);
                })
              )
            )
            .handle("remove", ({ params }) =>
              withFailureResponse(library.deletePlaylist(params.id))
            )
            .handleRaw("replaceMembers", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* replacePlaylistMembers() {
                  const input = yield* HttpServerRequest.schemaBodyJson(
                    PlaylistMembersPayload
                  );
                  return {
                    sets: yield* library.setPlaylistMembers(
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
                  return yield* library.setPlaylistMemberships(
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
              queue
                .read()
                .pipe(
                  Effect.map((listeningQueue) => ({ queue: listeningQueue }))
                )
            )
          )
          .handleRaw("play", () =>
            withFailureResponse(
              Effect.gen(function* setActiveQueueEntry() {
                const input =
                  yield* HttpServerRequest.schemaBodyJson(QueueSetPayload);
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
                  return yield* library.setPlaybackPosition(
                    params.id,
                    input.seconds
                  );
                })
              )
            )
            .handle("tags", () =>
              withFailureResponse(
                library.tags().pipe(Effect.map((tags) => ({ tags })))
              )
            )
            .handleRaw("updateTags", ({ params }) =>
              withFailureResponse(
                Effect.gen(function* updateTags() {
                  const input =
                    yield* HttpServerRequest.schemaBodyJson(TagsPayload);
                  return yield* library.updateTags(params.id, input.tags);
                })
              )
            )
      );
      const peopleGroup = HttpApiBuilder.group(OrbisApi, "people", (handlers) =>
        handlers
          .handle("me", () =>
            Effect.gen(function* readMe() {
              const { person } = yield* SetCaller;
              return { id: person.id, username: person.username };
            })
          )
          .handleRaw("updateMe", () =>
            withFailureResponse(
              Effect.gen(function* updateMe() {
                const caller = yield* SetCaller;
                const { username } =
                  yield* HttpServerRequest.schemaBodyJson(UpdateMePayload);
                const result = renamePerson(
                  devicesPath,
                  caller.person.id,
                  username
                );
                if (result.kind === "updated") {
                  return HttpServerResponse.jsonUnsafe({
                    id: result.person.id,
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
          Layer.provide(
            Layer.succeed(SetAccess, {
              bearer: (effect) =>
                Effect.flatMap(
                  Effect.withFiberSucceed((fiber) =>
                    Context.getOption(fiber.context, AcceptedAccess)
                  ),
                  Option.match({
                    onNone: () => Effect.die("Accepted access context missing"),
                    onSome: (access) =>
                      Effect.provideService(effect, SetCaller, access),
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
      Layer.provide(queueLayer),
      Layer.provide(libraryLayer),
      Layer.provide(statsLayer),
      Layer.provide(options.metadata ?? Metadata.unconfigured()),
      Layer.provide(options.titleReviser ?? TitleReviser.unconfigured())
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
      return app
        .handler(
          request,
          Context.add(
            Context.make(SetCaller, decision),
            AcceptedAccess,
            decision
          )
        )
        .then(withOrigin);
    },
  };
};
