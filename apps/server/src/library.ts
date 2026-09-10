import { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import type {
	SavedSet,
	SaveSetInput,
	LibraryFilters,
	Playlist,
} from "@orbis/contracts";
import { LibraryError } from "./errors.js";
import { normalizeSourceUrl } from "./source-url.js";

type SetRow = Omit<SavedSet, "tags"> & { tags: string };
const normalizeTags = (tags: readonly string[]) => [
	...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
];
const decodeRow = (row: SetRow): SavedSet => ({
	...row,
	tags: JSON.parse(row.tags) as string[],
});

export class Library extends Context.Service<
	Library,
	{
		readonly save: (
			input: SaveSetInput
		) => Effect.Effect<SavedSet, LibraryError>;
		readonly list: (
			filters: LibraryFilters
		) => Effect.Effect<SavedSet[], LibraryError>;
		readonly updateTags: (
			id: string,
			tags: readonly string[]
		) => Effect.Effect<SavedSet, LibraryError>;
		readonly tags: () => Effect.Effect<string[], LibraryError>;
		readonly playlists: () => Effect.Effect<Playlist[], LibraryError>;
		readonly createPlaylist: (
			name: string
		) => Effect.Effect<Playlist, LibraryError>;
		readonly setPlaylistMembers: (
			id: string,
			setIds: readonly string[]
		) => Effect.Effect<SavedSet[], LibraryError>;
	}
>()("@orbis/Library") {
	static layer(databasePath: string) {
		return Layer.effect(
			Library,
			Effect.gen(function* () {
				const db = yield* Effect.acquireRelease(
					Effect.sync(() => new Database(databasePath, { create: true })),
					(db) => Effect.sync(() => db.close())
				);
				yield* Effect.sync(() =>
					db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sets (
     id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
     source TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playlist_sets (
     playlist_id TEXT NOT NULL REFERENCES playlists(id), set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
     PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
    );`)
				);
				const execute = <A>(operation: () => A) =>
					Effect.try({
						try: operation,
						catch: (error) => {
							if (error instanceof LibraryError) return error;
							return new LibraryError({
								message: "Could not complete the library request.",
								statusCode: 500,
							});
						},
					});
				const requirePlaylist = (id: string) => {
					if (!db.query("SELECT id FROM playlists WHERE id = ?").get(id))
						throw new LibraryError({
							message: "Playlist not found.",
							statusCode: 404,
						});
				};
				const save = Effect.fn("Library.save")((input: SaveSetInput) =>
					execute(() => {
						if (!input.title.trim())
							throw new LibraryError({
								message: "Enter a title for this set.",
								statusCode: 400,
							});
						const set: SavedSet = {
							id: crypto.randomUUID(),
							...normalizeSourceUrl(input.url),
							title: input.title.trim(),
							tags: normalizeTags(input.tags),
							createdAt: new Date().toISOString(),
						};
						const result = db
							.prepare(
								"INSERT INTO sets (id, url, title, source, tags, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING"
							)
							.run(
								set.id,
								set.url,
								set.title,
								set.source,
								JSON.stringify(set.tags),
								set.createdAt
							);
						if (!result.changes)
							throw new LibraryError({
								message: "This set is already in your library.",
								statusCode: 409,
							});
						return set;
					})
				);
				const list = Effect.fn("Library.list")((filters: LibraryFilters) =>
					execute(() => {
						if (filters.playlistId) requirePlaylist(filters.playlistId);
						const clauses: string[] = [];
						const values: string[] = [];
						if (filters.playlistId) {
							clauses.push("playlist_sets.playlist_id = ?");
							values.push(filters.playlistId);
						}
						if (filters.q?.trim()) {
							clauses.push(
								"(instr(lower(title), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)"
							);
							values.push(filters.q.trim(), filters.q.trim());
						}
						if (filters.source) {
							clauses.push("source = ?");
							values.push(filters.source);
						}
						for (const tag of filters.tags ?? []) {
							clauses.push(
								"EXISTS (SELECT 1 FROM json_each(sets.tags) WHERE value = ?)"
							);
							values.push(tag.trim().toLowerCase());
						}
						const where = clauses.length
							? ` WHERE ${clauses.join(" AND ")}`
							: "";
						const join = filters.playlistId
							? " JOIN playlist_sets ON playlist_sets.set_id = sets.id"
							: "";
						const order = filters.playlistId
							? "playlist_sets.position"
							: "created_at DESC, sets.rowid DESC";
						return db
							.query<SetRow, string[]>(
								`SELECT sets.id, url, title, source, tags, created_at AS createdAt FROM sets${join}${where} ORDER BY ${order}`
							)
							.all(...values)
							.map(decodeRow);
					})
				);
				const updateTags = Effect.fn("Library.updateTags")(
					(id: string, tags: readonly string[]) =>
						execute(() => {
							const row = db
								.query<SetRow, [string, string]>(
									"UPDATE sets SET tags = ? WHERE id = ? RETURNING id, url, title, source, tags, created_at AS createdAt"
								)
								.get(JSON.stringify(normalizeTags(tags)), id);
							if (!row)
								throw new LibraryError({
									message: "Set not found.",
									statusCode: 404,
								});
							return decodeRow(row);
						})
				);
				const tags = Effect.fn("Library.tags")(() =>
					execute(() =>
						db
							.query<{ tag: string }, []>(
								"SELECT DISTINCT value AS tag FROM sets, json_each(sets.tags) ORDER BY tag"
							)
							.all()
							.map((row) => row.tag)
					)
				);
				const playlists = Effect.fn("Library.playlists")(() =>
					execute(() =>
						db
							.query<Playlist, []>(
								"SELECT id, name, created_at AS createdAt FROM playlists ORDER BY name COLLATE NOCASE"
							)
							.all()
					)
				);
				const createPlaylist = Effect.fn("Library.createPlaylist")(
					(name: string) =>
						execute(() => {
							if (!name.trim())
								throw new LibraryError({
									message: "Enter a playlist name.",
									statusCode: 400,
								});
							const playlist: Playlist = {
								id: crypto.randomUUID(),
								name: name.trim(),
								createdAt: new Date().toISOString(),
							};
							const result = db
								.query(
									"INSERT INTO playlists VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING"
								)
								.run(playlist.id, playlist.name, playlist.createdAt);
							if (!result.changes)
								throw new LibraryError({
									message: "A playlist with this name already exists.",
									statusCode: 409,
								});
							return playlist;
						})
				);
				const setPlaylistMembers = Effect.fn("Library.setPlaylistMembers")(
					function* (id: string, setIds: readonly string[]) {
						yield* execute(() =>
							db.transaction(() => {
								requirePlaylist(id);
								if (new Set(setIds).size !== setIds.length)
									throw new LibraryError({
										message: "A set can only appear once in a playlist.",
										statusCode: 400,
									});
								for (const setId of setIds) {
									if (!db.query("SELECT id FROM sets WHERE id = ?").get(setId))
										throw new LibraryError({
											message: "Set not found.",
											statusCode: 404,
										});
								}
								db.query("DELETE FROM playlist_sets WHERE playlist_id = ?").run(
									id
								);
								const insert = db.query(
									"INSERT INTO playlist_sets VALUES (?, ?, ?)"
								);
								setIds.forEach((setId, position) =>
									insert.run(id, setId, position)
								);
							})()
						);
						return yield* list({ playlistId: id });
					}
				);
				return {
					save,
					list,
					updateTags,
					tags,
					playlists,
					createPlaylist,
					setPlaylistMembers,
				};
			})
		);
	}
}
