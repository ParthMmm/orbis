import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { LibraryError } from "./errors.js";
import { Library } from "./library.js";

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
  title: Title,
  url: Schema.String.check(Schema.isMaxLength(2048)),
});

const respond = <A, E, R>(effect: Effect.Effect<A, E, R>, status = 200) =>
  Effect.match(effect, {
    onFailure: (error) =>
      HttpServerResponse.jsonUnsafe(
        {
          message:
            error instanceof LibraryError
              ? error.message
              : "Check your request fields and send valid JSON.",
        },
        { status: error instanceof LibraryError ? error.statusCode : 400 }
      ),
    onSuccess: (body) => HttpServerResponse.jsonUnsafe(body, { status }),
  });

export const createApp = ({ databasePath = ":memory:" } = {}) => {
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* registerRoutes() {
      const library = yield* Library;
      yield* router.add(
        "GET",
        "/health",
        HttpServerResponse.jsonUnsafe({ status: "ok" })
      );
      yield* router.add(
        "POST",
        "/sets",
        respond(
          Effect.gen(function* saveSet() {
            const input = yield* HttpServerRequest.schemaBodyJson(SaveInput);
            return yield* library.save({ ...input, tags: [...input.tags] });
          }),
          201
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
        "PUT",
        "/playlists/:id/sets",
        respond(
          Effect.gen(function* replacePlaylistMembers() {
            const { params } = yield* HttpRouter.RouteContext;
            const input = yield* HttpServerRequest.schemaBodyJson(
              Schema.Struct({
                setIds: Schema.Array(
                  Schema.String.check(Schema.isMaxLength(100))
                ).check(Schema.isMaxLength(500)),
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
    routes.pipe(Layer.provide(Library.layer(databasePath))),
    { disableLogger: true }
  );
  return {
    dispose: app.dispose,
    handler: (request: Request): Promise<Response> => {
      const host = request.headers.get("host") ?? new URL(request.url).host;
      // This slice is local-only. The Electron main process calls without a browser Origin.
      if (
        request.headers.has("origin") ||
        !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host)
      ) {
        return Promise.resolve(
          Response.json(
            { message: "Only local app requests are allowed." },
            { status: 403 }
          )
        );
      }
      return app.handler(request);
    },
  };
};
