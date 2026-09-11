import { Database } from "bun:sqlite";

import type {
  SavedSet,
  SaveSetInput,
  LibraryFilters,
  Playlist,
} from "@orbis/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { LibraryError } from "./errors.js";
import { normalizeSourceUrl } from "./source-url.js";

type SetRow = Omit<SavedSet, "tags" | "titleEditedByUser"> & {
  tags: string;
  titleEditedByUser: number;
};

const SET_COLUMNS = `id, url, title, source, tags, created_at AS createdAt, creator,
  artwork_url AS artworkUrl, duration_seconds AS durationSeconds,
  metadata_state AS metadataState, title_edited_by_user AS titleEditedByUser,
  download_state AS downloadState, retained_audio_bytes AS retainedAudioBytes,
  retained_audio_format AS retainedAudioFormat,
  playback_position_seconds AS playbackPositionSeconds,
  listen_count AS listenCount, finish_count AS finishCount,
  last_listened_at AS lastListenedAt`;

const CURRENT_SCHEMA_VERSION = 1;

const CREATE_SCHEMA = `CREATE TABLE IF NOT EXISTS sets (
 id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 source TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL,
 creator TEXT, artwork_url TEXT, duration_seconds INTEGER,
 metadata_state TEXT NOT NULL DEFAULT 'pending',
 title_edited_by_user INTEGER NOT NULL DEFAULT 0,
 download_state TEXT NOT NULL DEFAULT 'none',
 retained_audio_bytes INTEGER, retained_audio_format TEXT,
 playback_position_seconds INTEGER NOT NULL DEFAULT 0,
 listen_count INTEGER NOT NULL DEFAULT 0,
 finish_count INTEGER NOT NULL DEFAULT 0, last_listened_at TEXT
);
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_sets (
 playlist_id TEXT NOT NULL REFERENCES playlists(id), set_id TEXT NOT NULL REFERENCES sets(id), position INTEGER NOT NULL,
 PRIMARY KEY (playlist_id, set_id), UNIQUE (playlist_id, position)
);`;

const MIGRATIONS = [
  `ALTER TABLE sets ADD COLUMN creator TEXT;
   ALTER TABLE sets ADD COLUMN artwork_url TEXT;
   ALTER TABLE sets ADD COLUMN duration_seconds INTEGER;
   ALTER TABLE sets ADD COLUMN metadata_state TEXT NOT NULL DEFAULT 'pending';
   ALTER TABLE sets ADD COLUMN title_edited_by_user INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sets ADD COLUMN download_state TEXT NOT NULL DEFAULT 'none';
   ALTER TABLE sets ADD COLUMN retained_audio_bytes INTEGER;
   ALTER TABLE sets ADD COLUMN retained_audio_format TEXT;
   ALTER TABLE sets ADD COLUMN playback_position_seconds INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sets ADD COLUMN listen_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sets ADD COLUMN finish_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sets ADD COLUMN last_listened_at TEXT;`,
];

const ensureSchema = (db: Database) => {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const existing = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sets'"
    )
    .get();
  if (!existing) {
    db.exec(CREATE_SCHEMA);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    return;
  }
  // SAFETY: SQLite returns one row with an integer user_version column on every build,
  // and bun:sqlite types the result of an unlisted pragma as unknown.
  const { user_version: version } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let step = version + 1; step <= CURRENT_SCHEMA_VERSION; step += 1) {
    const statements = MIGRATIONS[step - 1];
    if (statements) {
      db.exec(statements);
    }
  }
  if (version < CURRENT_SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
};
const normalizeTags = (tags: readonly string[]) => [
  ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
];
const decodeRow = (row: SetRow): SavedSet => ({
  ...row,
  tags: Schema.decodeUnknownSync(Schema.mutable(Schema.Array(Schema.String)))(
    JSON.parse(row.tags)
  ),
  titleEditedByUser: row.titleEditedByUser === 1,
});

const execute = <A>(operation: () => A) =>
  Effect.try({
    catch: (error) => {
      if (error instanceof LibraryError) {
        return error;
      }
      return new LibraryError({
        message: "Could not complete the library request.",
        statusCode: 500,
      });
    },
    try: operation,
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
    readonly updateTitle: (
      id: string,
      title: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly remove: (id: string) => Effect.Effect<SavedSet, LibraryError>;
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
      Effect.gen(function* acquireLibrary() {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(databasePath, { create: true })),
          (database) => Effect.sync(() => database.close())
        );
        yield* Effect.sync(() => ensureSchema(db));
        const requirePlaylist = (id: string) => {
          if (!db.query("SELECT id FROM playlists WHERE id = ?").get(id)) {
            throw new LibraryError({
              message: "Playlist not found.",
              statusCode: 404,
            });
          }
        };
        const save = Effect.fn("Library.save")((input: SaveSetInput) =>
          execute(() => {
            if (!input.title.trim()) {
              throw new LibraryError({
                message: "Enter a title for this set.",
                statusCode: 400,
              });
            }
            const id = crypto.randomUUID();
            const { source, url } = normalizeSourceUrl(input.url);
            const title = input.title.trim();
            const tags = normalizeTags(input.tags);
            const createdAt = new Date().toISOString();
            const result = db
              .prepare(
                "INSERT INTO sets (id, url, title, source, tags, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING"
              )
              .run(id, url, title, source, JSON.stringify(tags), createdAt);
            if (!result.changes) {
              throw new LibraryError({
                message: "This set is already in your library.",
                statusCode: 409,
              });
            }
            const row = db
              .query<SetRow, [string]>(
                `SELECT ${SET_COLUMNS} FROM sets WHERE id = ?`
              )
              .get(id);
            // SAFETY: the insert above reported a change, so this row exists, and
            // SET_COLUMNS selects exactly the columns SetRow declares.
            return decodeRow(row as SetRow);
          })
        );
        const list = Effect.fn("Library.list")((filters: LibraryFilters) =>
          execute(() => {
            if (filters.playlistId) {
              requirePlaylist(filters.playlistId);
            }
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
                `SELECT ${SET_COLUMNS} FROM sets${join}${where} ORDER BY ${order}`
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
                  `UPDATE sets SET tags = ? WHERE id = ? RETURNING ${SET_COLUMNS}`
                )
                .get(JSON.stringify(normalizeTags(tags)), id);
              if (!row) {
                throw new LibraryError({
                  message: "Set not found.",
                  statusCode: 404,
                });
              }
              return decodeRow(row);
            })
        );
        const updateTitle = Effect.fn("Library.updateTitle")(
          (id: string, title: string) =>
            execute(() => {
              const trimmedTitle = title.trim();
              if (!trimmedTitle) {
                throw new LibraryError({
                  message: "Enter a title for this set.",
                  statusCode: 400,
                });
              }
              const row = db
                .query<SetRow, [string, string]>(
                  `UPDATE sets SET title = ? WHERE id = ? RETURNING ${SET_COLUMNS}`
                )
                .get(trimmedTitle, id);
              if (!row) {
                throw new LibraryError({
                  message: "Set not found.",
                  statusCode: 404,
                });
              }
              return decodeRow(row);
            })
        );
        const remove = Effect.fn("Library.remove")((id: string) =>
          execute(() =>
            db.transaction(() => {
              const row = db
                .query<SetRow, [string]>(
                  `SELECT ${SET_COLUMNS} FROM sets WHERE id = ?`
                )
                .get(id);
              if (!row) {
                throw new LibraryError({
                  message: "Set not found.",
                  statusCode: 404,
                });
              }
              db.query("DELETE FROM playlist_sets WHERE set_id = ?").run(id);
              db.query("DELETE FROM sets WHERE id = ?").run(id);
              return decodeRow(row);
            })()
          )
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
              if (!name.trim()) {
                throw new LibraryError({
                  message: "Enter a playlist name.",
                  statusCode: 400,
                });
              }
              const playlist: Playlist = {
                createdAt: new Date().toISOString(),
                id: crypto.randomUUID(),
                name: name.trim(),
              };
              const result = db
                .query(
                  "INSERT INTO playlists VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING"
                )
                .run(playlist.id, playlist.name, playlist.createdAt);
              if (!result.changes) {
                throw new LibraryError({
                  message: "A playlist with this name already exists.",
                  statusCode: 409,
                });
              }
              return playlist;
            })
        );
        const setPlaylistMembers = Effect.fn("Library.setPlaylistMembers")(
          function* setPlaylistMembers(id: string, setIds: readonly string[]) {
            yield* execute(() =>
              db.transaction(() => {
                requirePlaylist(id);
                if (new Set(setIds).size !== setIds.length) {
                  throw new LibraryError({
                    message: "A set can only appear once in a playlist.",
                    statusCode: 400,
                  });
                }
                for (const setId of setIds) {
                  if (
                    !db.query("SELECT id FROM sets WHERE id = ?").get(setId)
                  ) {
                    throw new LibraryError({
                      message: "Set not found.",
                      statusCode: 404,
                    });
                  }
                }
                db.query("DELETE FROM playlist_sets WHERE playlist_id = ?").run(
                  id
                );
                const insert = db.query(
                  "INSERT INTO playlist_sets VALUES (?, ?, ?)"
                );
                for (const [position, setId] of setIds.entries()) {
                  insert.run(id, setId, position);
                }
              })()
            );
            return yield* list({ playlistId: id });
          }
        );
        return {
          createPlaylist,
          list,
          playlists,
          remove,
          save,
          setPlaylistMembers,
          tags,
          updateTags,
          updateTitle,
        };
      })
    );
  }
}
