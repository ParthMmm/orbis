import { Effect, Layer, Schema } from "effect";
import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { Library } from "./library.js";
import { LibraryError } from "./errors.js";

const Tags = Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
	Schema.isMaxLength(20)
);
const Filters = Schema.Struct({
	playlistId: Schema.String.check(Schema.isMaxLength(100)),
	q: Schema.String.check(Schema.isMaxLength(200)),
	source: Schema.optionalKey(Schema.Literals(["youtube", "soundcloud"])),
	tags: Tags,
});
const SaveInput = Schema.Struct({
	url: Schema.String.check(Schema.isMaxLength(2048)),
	title: Schema.String.check(Schema.isMaxLength(200)),
	tags: Tags,
});

function respond<A, E, R>(effect: Effect.Effect<A, E, R>, status = 200) {
	return effect.pipe(
		Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { status })),
		Effect.catch((error) =>
			Effect.succeed(
				HttpServerResponse.jsonUnsafe(
					{
						message:
							error instanceof LibraryError
								? error.message
								: "Check your request fields and send valid JSON.",
					},
					{ status: error instanceof LibraryError ? error.statusCode : 400 }
				)
			)
		)
	);
}

export function createApp({ databasePath = ":memory:" } = {}) {
	const routes = HttpRouter.use((router) =>
		Effect.gen(function* () {
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
					Effect.gen(function* () {
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
					Effect.gen(function* () {
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
					Effect.gen(function* () {
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
					Effect.gen(function* () {
						const { params } = yield* HttpRouter.RouteContext;
						const input = yield* HttpServerRequest.schemaBodyJson(
							Schema.Struct({ tags: Tags })
						);
						return yield* library.updateTags(params.id ?? "", input.tags);
					})
				)
			);
			yield* router.add(
				"GET",
				"/sets",
				respond(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const params = new URL(request.url, "http://localhost")
							.searchParams;
						const filters = yield* Schema.decodeUnknownEffect(Filters)({
							playlistId: params.get("playlistId") ?? "",
							q: params.get("q") ?? "",
							...(params.has("source") ? { source: params.get("source") } : {}),
							tags: params.getAll("tag"),
						});
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
				!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)
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
}
