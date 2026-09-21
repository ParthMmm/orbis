import path from "node:path";

import type { SavedSet } from "@orbis/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { Audio } from "./audio.js";
import type { AudioFile, AudioOptions } from "./audio.js";
import { layer as databaseLayer } from "./db/database.js";
import { LibraryError } from "./errors.js";
import type { AccessMode } from "./identity.js";
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
import type { TitleReviserError } from "./title-reviser-error.js";
import { TitleReviser } from "./title-reviser.js";

interface RawFilters {
  playlistId: string;
  q: string;
  tags: string[];
  source?: string | null;
}

const Tags = Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
  Schema.isMaxLength(20)
);
const Title = Schema.String.check(Schema.isMaxLength(200));
const Filters = Schema.Struct({
  playlistId: Schema.String.check(Schema.isMaxLength(100)),
  q: Schema.String.check(Schema.isMaxLength(200)),
  source: Schema.optionalKey(Schema.Literals(["youtube", "soundcloud"])),
  tags: Tags,
});
const SaveInput = Schema.Struct({
  tags: Tags,
  title: Schema.optionalKey(Title),
  url: Schema.String.check(Schema.isMaxLength(2048)),
});

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
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      const audio = yield* Audio;
      const metadata = yield* Metadata;
      const titleReviser = yield* TitleReviser;
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
            library.recordEnrichment(set.id, enriched)
          ),
          Effect.catchTag("MetadataError", onMetadataFailure)
        );
      });
      yield* router.add(
        "GET",
        "/health",
        HttpServerResponse.jsonUnsafe({ status: "ok" })
      );
      yield* router.add(
        "POST",
        "/sets/:id/audio/download",
        Effect.match(
          Effect.gen(function* requestAudioDownload() {
            const { params } = yield* HttpRouter.RouteContext;
            const { accepted, set } = yield* audio.requestDownload(
              params.id ?? ""
            );
            return { set, status: accepted ? 202 : 200 };
          }).pipe(Effect.tapError(logLibraryFailure)),
          {
            onFailure: failureResponse,
            onSuccess: ({ set, status }) =>
              HttpServerResponse.jsonUnsafe(set, { status }),
          }
        )
      );
      yield* router.add(
        "GET",
        "/sets/:id/audio/state",
        respond(
          Effect.gen(function* readAudioState() {
            const { params } = yield* HttpRouter.RouteContext;
            return yield* audio.audioState(params.id ?? "");
          })
        )
      );
      yield* router.add(
        "GET",
        "/sets/:id/audio",
        Effect.match(
          Effect.gen(function* serveAudio() {
            const { params } = yield* HttpRouter.RouteContext;
            const file = yield* audio.audioFile(params.id ?? "");
            const request = yield* HttpServerRequest.HttpServerRequest;
            const range = audioRange(
              Option.getOrUndefined(Headers.get(request.headers, "range")),
              file.bytes
            );
            return audioFileResponse(file, range);
          }).pipe(Effect.tapError(logLibraryFailure)),
          { onFailure: failureResponse, onSuccess: (response) => response }
        )
      );
      yield* router.add(
        "DELETE",
        "/sets/:id/audio/download",
        respond(
          Effect.gen(function* cancelAudioDownload() {
            const { params } = yield* HttpRouter.RouteContext;
            return yield* audio.cancelDownload(params.id ?? "");
          })
        )
      );
      yield* router.add(
        "POST",
        "/sets",
        respond(
          Effect.gen(function* saveSet() {
            const input = yield* HttpServerRequest.schemaBodyJson(SaveInput);
            const saved = yield* library.save({
              tags: [...input.tags],
              title: input.title ?? "",
              url: input.url,
            });
            yield* Effect.logInfo("set saved").pipe(
              Effect.annotateLogs({ set: saved.id, source: saved.source })
            );
            // A typed title is final, so the desktop client keeps its offline save path.
            if (saved.titleEditedByUser) {
              return saved;
            }
            return yield* enrichSavedSet(saved);
          }),
          201
        )
      );
      yield* router.add(
        "POST",
        "/sets/:id/metadata",
        respond(
          Effect.gen(function* retryMetadata() {
            const { params } = yield* HttpRouter.RouteContext;
            return yield* enrichSavedSet(yield* library.find(params.id ?? ""));
          })
        )
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
      yield* router.add(
        "PATCH",
        "/sets/:id/title",
        respond(
          Effect.gen(function* updateTitle() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({ title: Title })
            );
            return yield* library.updateTitle(params.id ?? "", input.title);
          })
        )
      );
      yield* router.add(
        "DELETE",
        "/sets/:id",
        respond(
          Effect.gen(function* removeSet() {
            const { params } = yield* HttpRouter.RouteContext;
            return yield* library.remove(params.id ?? "");
          })
        )
      );
      yield* router.add(
        "GET",
        "/sets",
        respond(
          Effect.gen(function* listSets() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const params = new URL(request.url, "http://localhost")
              .searchParams;
            const rawFilters: RawFilters = {
              playlistId: params.get("playlistId") ?? "",
              q: params.get("q") ?? "",
              tags: params.getAll("tag"),
            };
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
      );
    })
  );
  const app = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(Audio.layer(options.audio ?? {})),
      Layer.provide(Library.layer.pipe(Layer.provide(database))),
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
      return app.handler(request);
    },
  };
};
