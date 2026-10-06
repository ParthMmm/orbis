import { and, eq, sql } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";

import {
  libraryEntries,
  people as peopleTable,
  playlistEditors,
  playlists,
  sets,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";

const hidden = () =>
  new LibraryError({ message: "Person not found.", statusCode: 404 });

export const resolveVisiblePerson = (
  people: readonly PersonRecord[],
  viewerId: string,
  targetId: string
): PersonRecord => {
  const viewer = people.find((person) => person.id === viewerId);
  const target = people.find((person) => person.id === targetId);
  if (
    !viewer ||
    !target ||
    viewer.id === target.id ||
    viewer.removed ||
    target.removed ||
    viewer.social !== true ||
    target.social !== true ||
    viewer.filters?.find((filter) => filter.personId === target.id)?.see ===
      false ||
    target.filters?.find((filter) => filter.personId === viewer.id)?.appear ===
      false
  ) {
    throw hidden();
  }
  return target;
};

export const canSee = (
  people: readonly PersonRecord[],
  viewerId: string,
  targetId: string
): boolean => {
  try {
    resolveVisiblePerson(people, viewerId, targetId);
    return true;
  } catch {
    return false;
  }
};

export const viewersOf = (people: readonly PersonRecord[], targetId: string) =>
  people
    .filter((person) => canSee(people, person.id, targetId))
    .map((person) => person.id);

const Filters = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      appear: Schema.Boolean,
      personId: Schema.String,
      see: Schema.Boolean,
    })
  )
);

export const readPeople = (db: DatabaseClient) =>
  db
    .select()
    .from(peopleTable)
    .orderBy(sql`rowid`)
    .pipe(
      Effect.flatMap((rows) =>
        Effect.all(
          rows.map((row) =>
            Schema.decodeUnknownEffect(Filters)(row.filters).pipe(
              Effect.map((filters): PersonRecord => ({
                autoDownload: row.autoDownload,
                filters,
                id: row.id,
                removed: row.removed,
                social: row.social,
                username: row.username,
              }))
            )
          )
        )
      )
    );

const missingPlaylist = () =>
  new LibraryError({ message: "Playlist not found.", statusCode: 404 });

export const resolveEditablePlaylist = (input: {
  readonly id: string;
  readonly personId: string;
  readonly people: readonly PersonRecord[];
}) =>
  Effect.gen(function* resolvePlaylist() {
    const db = yield* Database;
    const [owned] = yield* db
      .select({ id: playlists.id })
      .from(playlists)
      .where(
        and(eq(playlists.id, input.id), eq(playlists.creatorId, input.personId))
      )
      .limit(1);
    if (owned) {
      return input.personId;
    }
    const [editor] = yield* db
      .select({
        collaborative: playlists.collaborative,
        creatorId: playlistEditors.creatorId,
      })
      .from(playlistEditors)
      .innerJoin(playlists, eq(playlists.id, playlistEditors.playlistId))
      .where(
        and(
          eq(playlistEditors.playlistId, input.id),
          eq(playlistEditors.editorId, input.personId),
          eq(playlists.creatorId, playlistEditors.creatorId)
        )
      )
      .limit(1);
    if (
      !editor?.collaborative ||
      !canSee(input.people, input.personId, editor.creatorId) ||
      !canSee(input.people, editor.creatorId, input.personId)
    ) {
      return yield* Effect.fail(missingPlaylist());
    }
    return editor.creatorId;
  });

export const playlistReaders = (
  people: readonly PersonRecord[],
  playlistId: string
) =>
  Effect.gen(function* readPlaylistReaders() {
    const db = yield* Database;
    const [playlist] = yield* db
      .select({ creatorId: playlists.creatorId })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .limit(1);
    if (!playlist) {
      return [];
    }
    const editors = yield* db
      .select({ editorId: playlistEditors.editorId })
      .from(playlistEditors)
      .where(eq(playlistEditors.playlistId, playlistId));
    const readers = [playlist.creatorId];
    for (const { editorId } of editors) {
      const open = yield* resolveEditablePlaylist({
        id: playlistId,
        people,
        personId: editorId,
      }).pipe(Effect.option);
      if (Option.isSome(open)) {
        readers.push(editorId);
      }
    }
    return readers;
  });

export const editorAccess = (people: readonly PersonRecord[]) =>
  Effect.gen(function* readEditorAccess() {
    const db = yield* Database;
    const rows = yield* db
      .select({
        collaborative: playlists.collaborative,
        creatorId: playlists.creatorId,
        editorId: playlistEditors.editorId,
        playlistId: playlistEditors.playlistId,
      })
      .from(playlistEditors)
      .innerJoin(playlists, eq(playlists.id, playlistEditors.playlistId))
      .where(eq(playlists.creatorId, playlistEditors.creatorId))
      .orderBy(playlistEditors.playlistId);
    return rows.filter(
      (row) =>
        row.collaborative &&
        canSee(people, row.editorId, row.creatorId) &&
        canSee(people, row.creatorId, row.editorId)
    );
  });

/**
 * The People the viewer would see if their own See filter allowed it, with the
 * viewer's See and Appear filters for each. Setting See off must not drop a Person
 * from this list, or the viewer could never turn it back on; everything else in
 * the gate still applies, so a Person who hid from the viewer stays hidden.
 */
export const listFilterablePeople = (
  people: readonly PersonRecord[],
  viewerId: string
) => {
  const viewer = people.find((person) => person.id === viewerId);
  if (!viewer) {
    return [];
  }
  const seeingAll = people.map((person) =>
    person.id === viewerId
      ? {
          ...person,
          filters: (person.filters ?? []).map((filter) => ({
            ...filter,
            see: true,
          })),
        }
      : person
  );
  return people.flatMap((person) => {
    try {
      resolveVisiblePerson(seeingAll, viewerId, person.id);
    } catch {
      return [];
    }
    const filter = viewer.filters?.find((item) => item.personId === person.id);
    return [
      {
        appear: filter?.appear ?? true,
        id: person.id,
        see: filter?.see ?? true,
        username: person.username,
      },
    ];
  });
};

const notFound = () =>
  new LibraryError({ message: "Set not found.", statusCode: 404 });

/** Resolves a Set through an owned reference or another visible Person's Library. */
export const resolveVisibleSet = (input: {
  readonly id: string;
  readonly personId: string;
  readonly people: readonly PersonRecord[];
}) =>
  Effect.gen(function* resolveSet() {
    const db = yield* Database;
    const [row] = yield* db.select().from(sets).where(eq(sets.id, input.id));
    if (!row) {
      return yield* Effect.fail(notFound());
    }
    const entries = yield* db
      .select({ personId: libraryEntries.personId })
      .from(libraryEntries)
      .where(eq(libraryEntries.setId, input.id));
    if (
      entries.some((entry) => entry.personId === input.personId) ||
      (input.personId === "host" && !row.hostRemoved && entries.length === 0)
    ) {
      return row;
    }
    const [owned] = yield* db.all<{ readonly present: number }>(sql`
    SELECT 1 AS present FROM queue_entries WHERE person_id = ${input.personId} AND set_id = ${input.id}
    UNION ALL
    SELECT 1 AS present FROM playlist_sets INNER JOIN playlists ON playlists.id = playlist_sets.playlist_id
      WHERE playlists.creator_id = ${input.personId} AND playlist_sets.set_id = ${input.id}
    LIMIT 1
  `);
    if (owned) {
      return row;
    }
    for (const entry of entries) {
      const visible = yield* Effect.try({
        catch: () => notFound(),
        try: () =>
          resolveVisiblePerson(input.people, input.personId, entry.personId),
      }).pipe(Effect.option);
      if (Option.isSome(visible)) {
        return row;
      }
    }
    return yield* Effect.fail(notFound());
  });

export const setReaders = (people: readonly PersonRecord[], setId: string) =>
  Effect.filter(
    people.filter((person) => !person.removed).map((person) => person.id),
    (personId) =>
      resolveVisibleSet({ id: setId, people, personId }).pipe(
        Effect.as(true),
        Effect.catchTag("LibraryError", () => Effect.succeed(false))
      )
  );
