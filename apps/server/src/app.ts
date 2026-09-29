import path from "node:path";

import type { SavedSet } from "@orbis/contracts";
import {
  SaveSetPayload,
  SetsApi,
  SetAccess,
  SetCaller,
  UpdateTitlePayload,
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
import type { AccessDecision, AccessMode } from "./identity.js";
import { decideAccess, readDeviceRegistry } from "./identity.js";
import {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "./library-limits.js";
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

const Tags = Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
  Schema.isMaxLength(20)
);
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

// A Playback Position never goes backwards from zero, and the ceiling only refuses a number that
// is not a moment in any Set. A real position is bounded by the Set's own duration in the Library.
const PositionSeconds = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(604_800)
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

const respond = <A, E, R>(effect: Effect.Effect<A, E, R>, status = 200) =>
  Effect.match(effect.pipe(Effect.tapError(logLibraryFailure)), {
    onFailure: (error) => {
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
    },
    onSuccess: (body) => HttpServerResponse.jsonUnsafe(body, { status }),
  });

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
  const routes = HttpRouter.use((router) =>
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
      const setGroup = HttpApiBuilder.group(SetsApi, "sets", (handlers) =>
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
      yield* router.add(
        "GET",
        "/health",
        HttpServerResponse.jsonUnsafe({ status: "ok" })
      );
      yield* router.add(
        "GET",
        "/playlists",
        respond(
          library.playlists().pipe(Effect.map((playlists) => ({ playlists })))
        )
      );
      yield* router.add(
        "POST",
        "/playlists",
        respond(
          Effect.gen(function* createPlaylist() {
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                name: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return yield* library.createPlaylist(input.name);
          }),
          201
        )
      );
      yield* router.add(
        "PATCH",
        "/playlists/:id",
        respond(
          Effect.gen(function* renamePlaylist() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                name: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return yield* library.renamePlaylist(params.id ?? "", input.name);
          })
        )
      );
      yield* router.add(
        "DELETE",
        "/playlists/:id",
        respond(
          Effect.gen(function* deletePlaylist() {
            const { params } = yield* HttpRouter.RouteContext;
            return yield* library.deletePlaylist(params.id ?? "");
          })
        )
      );
      yield* router.add(
        "PUT",
        "/playlists/:id/sets",
        respond(
          Effect.gen(function* replacePlaylistMembers() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                setIds: Schema.Array(
                  Schema.String.check(Schema.isMaxLength(100))
                ).check(Schema.isMaxLength(MAX_SETS_PER_PLAYLIST)),
              })
            );
            return {
              sets: yield* library.setPlaylistMembers(
                params.id ?? "",
                input.setIds
              ),
            };
          })
        )
      );
      yield* router.add(
        "PUT",
        "/sets/:id/playlists",
        respond(
          Effect.gen(function* replaceSetPlaylists() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                playlistIds: Schema.Array(
                  Schema.String.check(Schema.isMaxLength(100))
                ).check(Schema.isMaxLength(MAX_PLAYLISTS_PER_SET)),
              })
            );
            return yield* library.setPlaylistMemberships(
              params.id ?? "",
              input.playlistIds
            );
          })
        )
      );
      yield* router.add(
        "GET",
        "/queue",
        respond(
          queue
            .read()
            .pipe(Effect.map((listeningQueue) => ({ queue: listeningQueue })))
        )
      );
      yield* router.add(
        "PUT",
        "/queue/active",
        respond(
          Effect.gen(function* setActiveQueueEntry() {
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                setId: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return { queue: yield* queue.play(input.setId) };
          })
        )
      );
      yield* router.add(
        "POST",
        "/queue/entries",
        respond(
          Effect.gen(function* addQueueEntry() {
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                placement: Schema.Literals(["next", "end"]),
                setId: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return { queue: yield* queue.insert(input.setId, input.placement) };
          }),
          201
        )
      );
      yield* router.add(
        "PUT",
        "/queue/playlist",
        respond(
          Effect.gen(function* replaceQueueFromPlaylist() {
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                playlistId: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return {
              queue: yield* queue.replaceWithPlaylist(input.playlistId),
            };
          })
        )
      );
      yield* router.add(
        "POST",
        "/queue/completion",
        respond(
          Effect.gen(function* completeQueueEntry() {
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                setId: Schema.String.check(Schema.isMaxLength(100)),
              })
            );
            return { queue: yield* queue.complete(input.setId) };
          })
        )
      );
      yield* router.add(
        "PUT",
        "/sets/:id/position",
        respond(
          Effect.gen(function* setPlaybackPosition() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({ seconds: PositionSeconds })
            );
            return yield* library.setPlaybackPosition(
              params.id ?? "",
              input.seconds
            );
          })
        )
      );
      yield* router.add(
        "GET",
        "/tags",
        respond(library.tags().pipe(Effect.map((tags) => ({ tags }))))
      );
      yield* router.add(
        "PATCH",
        "/sets/:id/tags",
        respond(
          Effect.gen(function* updateTags() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({ tags: Tags })
            );
            return yield* library.updateTags(params.id ?? "", input.tags);
          })
        )
      );
      yield* Layer.buildWithScope(
        HttpApiBuilder.layer(SetsApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(setGroup),
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
      mode: AccessMode = "local"
    ): Promise<Response> => {
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const authorization = request.headers.get("authorization");
      // Only a claimed token needs the trust store, so local requests never read it.
      const registry = readDeviceRegistry(
        authorization ? devicesPath : undefined
      );
      const decision = decideAccess({
        authorization,
        devices: registry.devices,
        hasOrigin: request.headers.has("origin"),
        host,
        mode,
      });
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
          Response.json(
            { message: decision.message },
            { status: decision.statusCode }
          )
        );
      }
      return app.handler(request, Context.make(AcceptedAccess, decision));
    },
  };
};
