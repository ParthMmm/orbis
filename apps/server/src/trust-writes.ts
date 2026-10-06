import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import { apiKeys, invites, people } from "./db/schema.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import { HOST_PERSON_ID } from "./identity.js";
import { readPeople } from "./visibility.js";

/**
 * Trust writes that change who can see or act, run on the caller's journal transaction so
 * the write, its Presence clear, and its feed resets commit together.
 */
const failure = (statusCode: number, message: string) =>
  new LibraryError({ message, statusCode });

export const revokeKey = (
  tx: DatabaseClient,
  id: string,
  ownerId?: string
) =>
  Effect.gen(function* revokeKeyRow() {
    // With `ownerId`, only that Person's daily keys match, and every other key answers the
    // same 404 as a missing one.
    const [key] = yield* tx
      .select({
        addedAt: apiKeys.addedAt,
        id: apiKeys.id,
        label: apiKeys.label,
        lastUsedAt: apiKeys.lastUsedAt,
        personId: apiKeys.personId,
        scope: apiKeys.scope,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, id),
          ownerId === undefined
            ? undefined
            : and(eq(apiKeys.personId, ownerId), eq(apiKeys.scope, "daily"))
        )
      )
      .limit(1);
    if (!key) {
      return yield* failure(404, "Key not found.");
    }
    yield* tx.delete(apiKeys).where(eq(apiKeys.id, id));
    return key;
  });

export const removePerson = (tx: DatabaseClient, id: string) =>
  Effect.gen(function* removePersonRow() {
    if (id === HOST_PERSON_ID) {
      return yield* failure(400, "Host cannot be removed.");
    }
    const [person] = yield* tx
      .select({ id: people.id, username: people.username })
      .from(people)
      .where(eq(people.id, id))
      .limit(1);
    if (!person) {
      return yield* failure(404, "Person not found.");
    }
    yield* tx.delete(invites).where(eq(invites.personId, id));
    const keys = yield* tx
      .delete(apiKeys)
      .where(eq(apiKeys.personId, id))
      .returning({ id: apiKeys.id });
    yield* tx.update(people).set({ removed: true }).where(eq(people.id, id));
    return { keyIds: keys.map((key) => key.id), person };
  });

export const updatePerson = (
  tx: DatabaseClient,
  personId: string,
  input: {
    readonly autoDownload?: boolean;
    readonly social?: boolean;
    readonly username?: string;
  }
) =>
  Effect.gen(function* updatePersonRow() {
    const name = input.username?.trim();
    if (
      (name !== undefined && (!name || name.length > 40)) ||
      (name === undefined &&
        input.autoDownload === undefined &&
        input.social === undefined)
    ) {
      return yield* failure(400, "Choose a username with 1 to 40 characters.");
    }
    if (name !== undefined) {
      const [taken] = yield* tx
        .select({ id: people.id })
        .from(people)
        .where(
          and(
            eq(people.removed, false),
            ne(people.id, personId),
            sql`lower(${people.username}) = ${name.toLowerCase()}`
          )
        )
        .limit(1);
      if (taken) {
        return yield* failure(409, "That username is already in use.");
      }
    }
    const [updated] = yield* tx
      .update(people)
      .set({
        ...(input.autoDownload !== undefined && {
          autoDownload: input.autoDownload,
        }),
        ...(input.social !== undefined && { social: input.social }),
        ...(name !== undefined && { username: name }),
      })
      .where(and(eq(people.id, personId), eq(people.removed, false)))
      .returning({
        autoDownload: people.autoDownload,
        id: people.id,
        social: people.social,
        username: people.username,
      });
    if (!updated) {
      return yield* failure(500, "The trust store is unavailable.");
    }
    return updated;
  });

export const updatePersonFilters = (
  tx: DatabaseClient,
  ownerId: string,
  targetId: string,
  input: { readonly see?: boolean; readonly appear?: boolean }
) =>
  Effect.gen(function* updateFilterRow() {
    if (input.see === undefined && input.appear === undefined) {
      return yield* failure(400, "Choose at least one filter.");
    }
    const everyone = yield* readPeople(tx);
    const owner = everyone.find(
      (person) => person.id === ownerId && !person.removed
    );
    const target = everyone.find(
      (person) => person.id === targetId && !person.removed
    );
    if (!owner || !target || ownerId === targetId) {
      return yield* failure(404, "Person not found.");
    }
    const previous = owner.filters?.find(
      (filter) => filter.personId === targetId
    );
    const filter = {
      appear: input.appear ?? previous?.appear ?? true,
      personId: targetId,
      see: input.see ?? previous?.see ?? true,
    };
    yield* tx
      .update(people)
      .set({
        filters: JSON.stringify([
          ...(owner.filters ?? []).filter(
            (item) => item.personId !== targetId
          ),
          filter,
        ]),
      })
      .where(eq(people.id, ownerId));
    return { appear: filter.appear, see: filter.see };
  });
