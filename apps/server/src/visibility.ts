import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "./db/database.js";
import { libraryEntries, sets } from "./db/schema.js";
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
