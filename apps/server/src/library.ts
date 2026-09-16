import type {
  LibraryFilters,
  Playlist,
  SavedSet,
  SaveSetInput,
  SetSource,
} from "@orbis/contracts";
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { Database } from "./db/database.js";
import { playlistSets, playlists, queueEntries, sets } from "./db/schema.js";
import { LibraryError } from "./errors.js";
import {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "./library-limits.js";
import type { EnrichedMetadata } from "./metadata.js";
import { normalizeSourceUrl } from "./source-url.js";

type SetRow = typeof sets.$inferSelect;

const JsonStringArray = Schema.fromJsonString(
  Schema.mutable(Schema.Array(Schema.String))
);

const TEMPORARY_TITLES: Record<SetSource, string> = {
  soundcloud: "SoundCloud track",
  youtube: "YouTube video",
};

const setNotFound = () =>
  new LibraryError({
    message: "Set not found.",
    statusCode: 404,
  });

const playlistNotFound = () =>
  new LibraryError({
    message: "Playlist not found.",
    statusCode: 404,
  });

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the library request.",
    statusCode: 500,
  });

const playlistCapacityError = () =>
  new LibraryError({
    message: `A playlist can hold at most ${MAX_SETS_PER_PLAYLIST} sets.`,
    statusCode: 400,
  });

const setCapacityError = () =>
  new LibraryError({
    message: `A set can belong to at most ${MAX_PLAYLISTS_PER_SET} playlists.`,
    statusCode: 400,
  });

const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();

const execute = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.mapError(toLibraryError));

const decodeJsonArray = (value: string) =>
  Schema.decodeUnknownEffect(JsonStringArray)(value);

const normalizeUrl = (value: string) =>
  Effect.try({
    catch: toLibraryError,
    try: () => normalizeSourceUrl(value),
  });

const normalizeTags = (tags: readonly string[]) => [
  ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
];

export class Library extends Context.Service<
  Library,
  {
    readonly save: (
      input: SaveSetInput
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly find: (id: string) => Effect.Effect<SavedSet, LibraryError>;
    /** The Sets with these identifiers, in the order asked for. Missing ones are left out. */
    readonly byIds: (
      ids: readonly string[]
    ) => Effect.Effect<SavedSet[], LibraryError>;
    readonly setPlaybackPosition: (
      id: string,
      seconds: number
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly recordEnrichment: (
      id: string,
      metadata: EnrichedMetadata
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly recordEnrichmentFailure: (
      id: string
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
    readonly renamePlaylist: (
      id: string,
      name: string
    ) => Effect.Effect<Playlist, LibraryError>;
    readonly deletePlaylist: (
      id: string
    ) => Effect.Effect<Playlist, LibraryError>;
    readonly setPlaylistMembers: (
      id: string,
      setIds: readonly string[]
    ) => Effect.Effect<SavedSet[], LibraryError>;
    readonly setPlaylistMemberships: (
      id: string,
      playlistIds: readonly string[]
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly queueDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly claimDownload: () => Effect.Effect<SavedSet | null, LibraryError>;
    readonly finishDownload: (
      id: string,
      audio: { bytes: number; format: string; durationSeconds: number }
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly failDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly cancelDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly resetStuckDownloads: () => Effect.Effect<number, LibraryError>;
  }
>()("@orbis/Library") {
  static readonly layer = Layer.effect(
    Library,
    Effect.gen(function* layer() {
      const db = yield* Database;

      const playlistIdsFor = (setId: string) =>
        db
          .select({ playlistId: playlistSets.playlistId })
          .from(playlistSets)
          .where(eq(playlistSets.setId, setId))
          .orderBy(asc(playlistSets.playlistId))
          .pipe(Effect.map((rows) => rows.map((row) => row.playlistId)));

      const hydrateSet = Effect.fn("Library.hydrateSet")(
        (
          row: SetRow,
          playlistIds: Effect.Effect<string[], unknown> = playlistIdsFor(row.id)
        ) =>
          Effect.gen(function* hydrateSetEffect() {
            const tags = yield* decodeJsonArray(row.tags);
            return {
              ...row,
              playlistIds: yield* playlistIds,
              tags,
            };
          })
      );

      const findRow = (id: string) =>
        db.select().from(sets).where(eq(sets.id, id)).limit(1);

      const findSavedSet = (id: string) =>
        Effect.gen(function* findSavedSetEffect() {
          const [row] = yield* findRow(id);
          if (!row) {
            return yield* Effect.fail(setNotFound());
          }
          return yield* hydrateSet(row);
        });

      const save = Effect.fn("Library.save")((input: SaveSetInput) =>
        execute(
          Effect.gen(function* saveSetEffect() {
            const id = crypto.randomUUID();
            const { source, url } = yield* normalizeUrl(input.url);
            const title = input.title?.trim() ?? "";
            const tags = normalizeTags(input.tags);
            const [row] = yield* db
              .insert(sets)
              .values({
                createdAt: new Date().toISOString(),
                id,
                source,
                tags: JSON.stringify(tags),
                title: title || TEMPORARY_TITLES[source],
                titleEditedByUser: Boolean(title),
                url,
              })
              .onConflictDoNothing()
              .returning();
            if (!row) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "This set is already in your library.",
                  statusCode: 409,
                })
              );
            }
            return yield* hydrateSet(row);
          })
        )
      );

      const list = Effect.fn("Library.list")((filters: LibraryFilters) =>
        execute(
          Effect.gen(function* listSetsEffect() {
            const conditions = [];
            if (filters.q?.trim()) {
              const query = filters.q.trim();
              conditions.push(
                sql`(
                  instr(lower(${sets.title}), lower(${query})) > 0
                  OR instr(lower(${sets.url}), lower(${query})) > 0
                  OR instr(lower(coalesce(${sets.creator}, '')), lower(${query})) > 0
                )`
              );
            }
            if (filters.source) {
              conditions.push(eq(sets.source, filters.source));
            }
            for (const tag of filters.tags ?? []) {
              conditions.push(
                sql`EXISTS (
                  SELECT 1 FROM json_each(${sets.tags})
                  WHERE value = ${tag.trim().toLowerCase()}
                )`
              );
            }

            const { playlistId } = filters;
            const playlistIds = sql<string>`(
              SELECT COALESCE(
                json_group_array(${playlistSets.playlistId} ORDER BY ${playlistSets.playlistId}),
                '[]'
              )
              FROM ${playlistSets}
              WHERE ${playlistSets.setId} = ${sets.id}
            )`;
            if (playlistId) {
              const playlist = yield* db
                .select({ id: playlists.id })
                .from(playlists)
                .where(eq(playlists.id, playlistId))
                .limit(1);
              if (!playlist[0]) {
                return yield* Effect.fail(playlistNotFound());
              }
              const rows = yield* db
                .select({ playlistIds, set: sets })
                .from(sets)
                .innerJoin(playlistSets, eq(playlistSets.setId, sets.id))
                .where(
                  and(...conditions, eq(playlistSets.playlistId, playlistId))
                )
                .orderBy(asc(playlistSets.position));
              return yield* Effect.forEach((row: (typeof rows)[number]) =>
                hydrateSet(row.set, decodeJsonArray(row.playlistIds))
              )(rows);
            }

            const rows = yield* db
              .select({ playlistIds, set: sets })
              .from(sets)
              .where(and(...conditions))
              .orderBy(desc(sets.createdAt), desc(sql`rowid`));
            return yield* Effect.forEach((row: (typeof rows)[number]) =>
              hydrateSet(row.set, decodeJsonArray(row.playlistIds))
            )(rows);
          })
        )
      );

      const updateTags = Effect.fn("Library.updateTags")(
        (id: string, tags: readonly string[]) =>
          execute(
            Effect.gen(function* updateTagsEffect() {
              const rows = yield* db
                .update(sets)
                .set({ tags: JSON.stringify(normalizeTags(tags)) })
                .where(eq(sets.id, id))
                .returning();
              const [row] = rows;
              if (!row) {
                return yield* Effect.fail(setNotFound());
              }
              return yield* hydrateSet(row);
            })
          )
      );

      const updateTitle = Effect.fn("Library.updateTitle")(
        (id: string, title: string) =>
          execute(
            Effect.gen(function* updateTitleEffect() {
              const trimmedTitle = title.trim();
              if (!trimmedTitle) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "Enter a title for this set.",
                    statusCode: 400,
                  })
                );
              }
              const rows = yield* db
                .update(sets)
                .set({ title: trimmedTitle, titleEditedByUser: true })
                .where(eq(sets.id, id))
                .returning();
              const [row] = rows;
              if (!row) {
                return yield* Effect.fail(setNotFound());
              }
              return yield* hydrateSet(row);
            })
          )
      );

      const find = Effect.fn("Library.find")((id: string) =>
        execute(findSavedSet(id))
      );

      // One query for a whole Listening Queue, rather than a find per entry. The order comes from
      // the caller, because that order is the queue's, not the database's.
      const byIds = Effect.fn("Library.byIds")((ids: readonly string[]) =>
        execute(
          Effect.gen(function* byIdsEffect() {
            if (ids.length === 0) {
              return [];
            }
            const rows = yield* db
              .select()
              .from(sets)
              .where(inArray(sets.id, [...ids]));
            const found = new Map(rows.map((row) => [row.id, row]));
            return yield* Effect.forEach(
              ids.flatMap((id) => {
                const row = found.get(id);
                return row ? [row] : [];
              }),
              (row) => hydrateSet(row)
            );
          })
        )
      );

      // A position past the end of the Set is not a place to resume from, and a fraction of a
      // second is not a value the app can read back, so both are settled here rather than stored
      // and explained later.
      const setPlaybackPosition = Effect.fn("Library.setPlaybackPosition")(
        (id: string, seconds: number) =>
          execute(
            Effect.gen(function* setPlaybackPositionEffect() {
              const [current] = yield* findRow(id);
              if (!current) {
                return yield* Effect.fail(setNotFound());
              }
              const wanted = Math.max(seconds, 0);
              const bounded =
                current.durationSeconds === null
                  ? wanted
                  : Math.min(wanted, current.durationSeconds);
              const [row] = yield* db
                .update(sets)
                .set({ playbackPositionSeconds: Math.round(bounded) })
                .where(eq(sets.id, id))
                .returning();
              if (!row) {
                return yield* Effect.fail(setNotFound());
              }
              return yield* hydrateSet(row);
            })
          )
      );

      const recordEnrichment = Effect.fn("Library.recordEnrichment")(
        (id: string, metadata: EnrichedMetadata) =>
          execute(
            Effect.gen(function* recordEnrichmentEffect() {
              const rows = yield* db
                .update(sets)
                .set({
                  artworkLargeUrl: metadata.artworkLargeUrl,
                  artworkUrl: metadata.artworkUrl,
                  creator: metadata.creator,
                  durationSeconds: metadata.durationSeconds,
                  metadataState: "enriched",
                  title: sql<string>`CASE
                  WHEN ${sets.titleEditedByUser} = 1 THEN ${sets.title}
                  ELSE ${metadata.title}
                END`,
                })
                .where(eq(sets.id, id))
                .returning();
              const [row] = rows;
              if (!row) {
                return yield* Effect.fail(setNotFound());
              }
              return yield* hydrateSet(row);
            })
          )
      );

      const recordEnrichmentFailure = Effect.fn(
        "Library.recordEnrichmentFailure"
      )((id: string) =>
        execute(
          Effect.gen(function* recordEnrichmentFailureEffect() {
            const rows = yield* db
              .update(sets)
              .set({ metadataState: "failed" })
              .where(eq(sets.id, id))
              .returning();
            const [row] = rows;
            if (!row) {
              return yield* Effect.fail(setNotFound());
            }
            return yield* hydrateSet(row);
          })
        )
      );

      const remove = Effect.fn("Library.remove")((id: string) =>
        execute(
          Effect.gen(function* removeEffect() {
            const saved = yield* findSavedSet(id);
            yield* db.transaction((tx) =>
              Effect.gen(function* removeTransaction() {
                yield* tx
                  .delete(playlistSets)
                  .where(eq(playlistSets.setId, id));
                // A removed Set cannot stay scheduled for playback: the queue would hold an
                // entry with nothing behind it.
                yield* tx
                  .delete(queueEntries)
                  .where(eq(queueEntries.setId, id));
                yield* tx.delete(sets).where(eq(sets.id, id));
              })
            );
            return saved;
          })
        )
      );

      // A download request never disturbs finished or running work. A Set with no
      // download, or one that failed or was canceled, enters the queue; ready and
      // in-flight states stay put. Every stored set comes from a source Cobalt
      // handles, so the worker's verdict — not a source check here — decides the rest.
      const queueDownload = Effect.fn("Library.queueDownload")((id: string) =>
        execute(
          Effect.gen(function* queueDownloadEffect() {
            const [queued] = yield* db
              .update(sets)
              .set({ downloadState: "queued" })
              .where(
                and(
                  eq(sets.id, id),
                  inArray(sets.downloadState, ["none", "failed", "canceled"])
                )
              )
              .returning();
            if (queued) {
              return yield* hydrateSet(queued);
            }
            return yield* findSavedSet(id);
          })
        )
      );
      // One statement claims the oldest queued set, so two workers could never take the
      // same row. There is only one worker, and the single statement keeps it that way
      // even if that ever changes.
      const claimDownload = Effect.fn("Library.claimDownload")(() =>
        execute(
          Effect.gen(function* claimDownloadEffect() {
            const oldest = db
              .select({ id: sets.id })
              .from(sets)
              .where(eq(sets.downloadState, "queued"))
              .orderBy(asc(sets.createdAt), asc(sets.id))
              .limit(1);
            const [claimed] = yield* db
              .update(sets)
              .set({ downloadState: "downloading" })
              .where(eq(sets.id, oldest))
              .returning();
            if (!claimed) {
              return null;
            }
            return yield* hydrateSet(claimed);
          })
        )
      );
      const finishDownload = Effect.fn("Library.finishDownload")(
        (
          id: string,
          audio: { bytes: number; format: string; durationSeconds: number }
        ) =>
          execute(
            Effect.gen(function* finishDownloadEffect() {
              // Whole seconds: SQLite keeps the fraction under INTEGER affinity, and
              // the app decodes an integer, so a fraction would unreadable the library.
              const [row] = yield* db
                .update(sets)
                .set({
                  downloadState: "ready",
                  durationSeconds: Math.round(audio.durationSeconds),
                  retainedAudioBytes: audio.bytes,
                  retainedAudioFormat: audio.format,
                })
                .where(eq(sets.id, id))
                .returning();
              if (!row) {
                return yield* Effect.fail(setNotFound());
              }
              return yield* hydrateSet(row);
            })
          )
      );
      // Only a download still running can fail. A cancel that won the race already
      // moved the row to none, and a failure must not drag it back to failed.
      const failDownload = Effect.fn("Library.failDownload")((id: string) =>
        execute(
          Effect.gen(function* failDownloadEffect() {
            const [failed] = yield* db
              .update(sets)
              .set({ downloadState: "failed" })
              .where(
                and(eq(sets.id, id), eq(sets.downloadState, "downloading"))
              )
              .returning();
            if (failed) {
              return yield* hydrateSet(failed);
            }
            return yield* findSavedSet(id);
          })
        )
      );
      // Finished downloads are kept: canceling a ready set is a conflict, not a delete.
      // The app reports a 409 as a duplicate library entry, so a finished download
      // that cannot be canceled answers 400 with its own sentence.
      const cancelDownload = Effect.fn("Library.cancelDownload")((id: string) =>
        execute(
          Effect.gen(function* cancelDownloadEffect() {
            const [canceled] = yield* db
              .update(sets)
              .set({
                downloadState: "none",
                retainedAudioBytes: null,
                retainedAudioFormat: null,
              })
              .where(and(eq(sets.id, id), ne(sets.downloadState, "ready")))
              .returning();
            if (canceled) {
              return yield* hydrateSet(canceled);
            }
            yield* findSavedSet(id);
            return yield* Effect.fail(
              new LibraryError({
                message: "This set is already downloaded.",
                statusCode: 400,
              })
            );
          })
        )
      );
      // A restart must not leave a download stuck mid-flight: whatever was running
      // when the process died goes back to queued and the worker picks it up again.
      const resetStuckDownloads = Effect.fn("Library.resetStuckDownloads")(() =>
        execute(
          Effect.gen(function* resetStuckDownloadsEffect() {
            yield* db
              .update(sets)
              .set({ downloadState: "queued" })
              .where(eq(sets.downloadState, "downloading"));
            const queued = yield* db
              .select({ id: sets.id })
              .from(sets)
              .where(eq(sets.downloadState, "queued"));
            return queued.length;
          })
        )
      );
      const tags = Effect.fn("Library.tags")(() =>
        execute(
          db
            .all<{ readonly tag: string }>(
              sql`SELECT DISTINCT value AS tag
                FROM ${sets}, json_each(${sets.tags})
                ORDER BY tag`
            )
            .pipe(Effect.map((rows) => rows.map((row) => row.tag)))
        )
      );

      const playlistsList = Effect.fn("Library.playlists")(() =>
        execute(
          db
            .select({
              createdAt: playlists.createdAt,
              id: playlists.id,
              name: playlists.name,
              setCount: sql<number>`(
                SELECT COUNT(*)
                FROM ${playlistSets}
                WHERE ${playlistSets.playlistId} = ${playlists.id}
              )`,
            })
            .from(playlists)
            .orderBy(asc(sql`${playlists.name} COLLATE NOCASE`))
        )
      );

      const createPlaylist = Effect.fn("Library.createPlaylist")(
        (name: string) =>
          execute(
            Effect.gen(function* createPlaylistEffect() {
              const trimmedName = name.trim();
              if (!trimmedName) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "Enter a playlist name.",
                    statusCode: 400,
                  })
                );
              }
              const playlist = {
                createdAt: new Date().toISOString(),
                id: crypto.randomUUID(),
                name: trimmedName,
                setCount: 0,
              } satisfies Playlist;
              const inserted = yield* db
                .insert(playlists)
                .values({
                  createdAt: playlist.createdAt,
                  id: playlist.id,
                  name: playlist.name,
                })
                .onConflictDoNothing()
                .returning();
              if (!inserted[0]) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "A playlist with this name already exists.",
                    statusCode: 409,
                  })
                );
              }
              return playlist;
            })
          )
      );

      const renamePlaylist = Effect.fn("Library.renamePlaylist")(
        (id: string, name: string) =>
          execute(
            Effect.gen(function* renamePlaylistEffect() {
              const trimmedName = name.trim();
              if (!trimmedName) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "Enter a playlist name.",
                    statusCode: 400,
                  })
                );
              }
              const playlist = yield* db
                .select({ id: playlists.id })
                .from(playlists)
                .where(eq(playlists.id, id))
                .limit(1);
              if (!playlist[0]) {
                return yield* Effect.fail(playlistNotFound());
              }
              const taken = yield* db
                .select({ id: playlists.id })
                .from(playlists)
                .where(
                  and(
                    sql`lower(${playlists.name}) = ${trimmedName.toLowerCase()}`,
                    ne(playlists.id, id)
                  )
                )
                .limit(1);
              if (taken[0]) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "A playlist with this name already exists.",
                    statusCode: 409,
                  })
                );
              }
              const [row] = yield* db
                .update(playlists)
                .set({ name: trimmedName })
                .where(eq(playlists.id, id))
                .returning({
                  createdAt: playlists.createdAt,
                  id: playlists.id,
                  name: playlists.name,
                });
              if (!row) {
                return yield* Effect.fail(playlistNotFound());
              }
              const countRows = yield* db
                .select({ count: sql<number>`COUNT(*)` })
                .from(playlistSets)
                .where(eq(playlistSets.playlistId, id));
              return {
                createdAt: row.createdAt,
                id: row.id,
                name: row.name,
                setCount: countRows[0]?.count ?? 0,
              } satisfies Playlist;
            })
          )
      );

      const deletePlaylist = Effect.fn("Library.deletePlaylist")((id: string) =>
        execute(
          Effect.gen(function* deletePlaylistEffect() {
            const playlist = yield* db
              .select({
                createdAt: playlists.createdAt,
                id: playlists.id,
                name: playlists.name,
                setCount: sql<number>`(
                  SELECT COUNT(*)
                  FROM ${playlistSets}
                  WHERE ${playlistSets.playlistId} = ${playlists.id}
                )`,
              })
              .from(playlists)
              .where(eq(playlists.id, id))
              .limit(1);
            const [row] = playlist;
            if (!row) {
              return yield* Effect.fail(playlistNotFound());
            }
            yield* db.transaction((tx) =>
              Effect.gen(function* deletePlaylistTransaction() {
                yield* tx
                  .delete(playlistSets)
                  .where(eq(playlistSets.playlistId, id));
                yield* tx.delete(playlists).where(eq(playlists.id, id));
              })
            );
            return row;
          })
        )
      );

      const setPlaylistMembers = Effect.fn("Library.setPlaylistMembers")(
        (id: string, setIds: readonly string[]) =>
          execute(
            Effect.gen(function* setPlaylistMembersEffect() {
              yield* db.transaction((tx) =>
                Effect.gen(function* setPlaylistMembersTransaction() {
                  const playlist = yield* tx
                    .select({ id: playlists.id })
                    .from(playlists)
                    .where(eq(playlists.id, id))
                    .limit(1);
                  if (!playlist[0]) {
                    return yield* Effect.fail(playlistNotFound());
                  }
                  if (new Set(setIds).size !== setIds.length) {
                    return yield* Effect.fail(
                      new LibraryError({
                        message: "A set can only appear once in a playlist.",
                        statusCode: 400,
                      })
                    );
                  }
                  if (setIds.length > MAX_SETS_PER_PLAYLIST) {
                    return yield* Effect.fail(playlistCapacityError());
                  }
                  for (const setId of setIds) {
                    const set = yield* tx
                      .select({ id: sets.id })
                      .from(sets)
                      .where(eq(sets.id, setId))
                      .limit(1);
                    if (!set[0]) {
                      return yield* Effect.fail(setNotFound());
                    }
                  }

                  const currentRows = yield* tx
                    .select({ setId: playlistSets.setId })
                    .from(playlistSets)
                    .where(eq(playlistSets.playlistId, id));
                  const currentSetIds = new Set(
                    currentRows.map((row) => row.setId)
                  );
                  for (const setId of setIds) {
                    if (currentSetIds.has(setId)) {
                      continue;
                    }
                    const countRows = yield* tx
                      .select({ count: sql<number>`COUNT(*)` })
                      .from(playlistSets)
                      .where(eq(playlistSets.setId, setId));
                    if (
                      (countRows[0]?.count ?? 0) + 1 >
                      MAX_PLAYLISTS_PER_SET
                    ) {
                      return yield* Effect.fail(setCapacityError());
                    }
                  }

                  yield* tx
                    .delete(playlistSets)
                    .where(eq(playlistSets.playlistId, id));
                  if (setIds.length > 0) {
                    yield* tx.insert(playlistSets).values(
                      setIds.map((setId, position) => ({
                        playlistId: id,
                        position,
                        setId,
                      }))
                    );
                  }
                })
              );
              return yield* list({ playlistId: id });
            })
          )
      );

      const setPlaylistMemberships = Effect.fn(
        "Library.setPlaylistMemberships"
      )((setId: string, playlistIds: readonly string[]) =>
        execute(
          Effect.gen(function* setPlaylistMembershipsEffect() {
            yield* db.transaction((tx) =>
              Effect.gen(function* setPlaylistMembershipsTransaction() {
                const set = yield* tx
                  .select({ id: sets.id })
                  .from(sets)
                  .where(eq(sets.id, setId))
                  .limit(1);
                if (!set[0]) {
                  return yield* Effect.fail(setNotFound());
                }
                if (new Set(playlistIds).size !== playlistIds.length) {
                  return yield* Effect.fail(
                    new LibraryError({
                      message: "A set can only appear once in a playlist.",
                      statusCode: 400,
                    })
                  );
                }
                if (playlistIds.length > MAX_PLAYLISTS_PER_SET) {
                  return yield* Effect.fail(setCapacityError());
                }
                for (const playlistId of playlistIds) {
                  const playlist = yield* tx
                    .select({ id: playlists.id })
                    .from(playlists)
                    .where(eq(playlists.id, playlistId))
                    .limit(1);
                  if (!playlist[0]) {
                    return yield* Effect.fail(playlistNotFound());
                  }
                }

                const currentRows = yield* tx
                  .select({ playlistId: playlistSets.playlistId })
                  .from(playlistSets)
                  .where(eq(playlistSets.setId, setId));
                const currentPlaylistIds = new Set(
                  currentRows.map((row) => row.playlistId)
                );
                for (const playlistId of playlistIds) {
                  if (currentPlaylistIds.has(playlistId)) {
                    continue;
                  }
                  const countRows = yield* tx
                    .select({ count: sql<number>`COUNT(*)` })
                    .from(playlistSets)
                    .where(eq(playlistSets.playlistId, playlistId));
                  if ((countRows[0]?.count ?? 0) + 1 > MAX_SETS_PER_PLAYLIST) {
                    return yield* Effect.fail(playlistCapacityError());
                  }
                }

                yield* tx
                  .delete(playlistSets)
                  .where(
                    playlistIds.length > 0
                      ? and(
                          eq(playlistSets.setId, setId),
                          notInArray(playlistSets.playlistId, [...playlistIds])
                        )
                      : eq(playlistSets.setId, setId)
                  );

                for (const playlistId of playlistIds) {
                  if (currentPlaylistIds.has(playlistId)) {
                    continue;
                  }
                  const positionRows = yield* tx
                    .select({
                      position: sql<number>`COALESCE(MAX(${playlistSets.position}) + 1, 0)`,
                    })
                    .from(playlistSets)
                    .where(eq(playlistSets.playlistId, playlistId));
                  yield* tx
                    .insert(playlistSets)
                    .values({
                      playlistId,
                      position: positionRows[0]?.position ?? 0,
                      setId,
                    })
                    .onConflictDoNothing();
                }
              })
            );
            return yield* findSavedSet(setId);
          })
        )
      );

      return {
        byIds,
        cancelDownload,
        claimDownload,
        createPlaylist,
        deletePlaylist,
        failDownload,
        find,
        finishDownload,
        list,
        playlists: playlistsList,
        queueDownload,
        recordEnrichment,
        recordEnrichmentFailure,
        remove,
        renamePlaylist,
        resetStuckDownloads,
        save,
        setPlaybackPosition,
        setPlaylistMembers,
        setPlaylistMemberships,
        tags,
        updateTags,
        updateTitle,
      };
    })
  );
}
