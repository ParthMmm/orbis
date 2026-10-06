import type { ListeningQueue, Presence as PresenceEntry } from "@orbis/contracts";
import { and, asc, eq, lte } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";

import {
  apiKeys,
  feedDeliveries,
  feedRecipients,
  playlists,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";
import { RETENTION_MS } from "./journal.js";
import type { FeedNotice, FeedTopic } from "./journal.js";
import { Library } from "./library.js";
import type { Presence } from "./presence.js";
import { readListeningQueue } from "./queue.js";
import {
  canSee,
  readPeople,
  resolveEditablePlaylist,
  resolveVisibleSet,
} from "./visibility.js";

export type { FeedNotice } from "./journal.js";

export type FeedBody =
  | { readonly kind: "queue"; readonly queue: ListeningQueue }
  | { readonly kind: "presence"; readonly presence: readonly PresenceEntry[] }
  | {
      readonly kind: "invalidate";
      readonly topic: Exclude<FeedTopic, "queue" | "presence">;
      readonly resourceId?: string;
    };
export interface FeedDelivery {
  readonly cursor: string;
  readonly body: FeedBody;
}
export type ResetReason = "expired" | "invalid" | "access";
export interface FeedSnapshot {
  readonly cursor: string;
  readonly queue: ListeningQueue;
  readonly presence: readonly PresenceEntry[];
}
export type CatchUp =
  | {
      readonly kind: "changes";
      readonly deliveries: readonly FeedDelivery[];
      readonly cursor: string;
    }
  | {
      readonly kind: "snapshot";
      readonly reset: ResetReason | null;
      readonly snapshot: FeedSnapshot;
    }
  | { readonly kind: "closed" };

interface Cursor {
  readonly keyId: string;
  readonly epoch: number;
  readonly sequence: number;
  readonly tag: string | null;
}

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(
    `1:${cursor.keyId}:${cursor.epoch}:${cursor.sequence}:${cursor.tag ?? ""}`
  ).toString("base64url");

const decodeCursor = (value: string): Cursor | null => {
  const parts = Buffer.from(value, "base64url").toString("utf-8").split(":");
  const [version, keyId, epoch, sequence, tag] = parts;
  if (
    parts.length !== 5 ||
    version !== "1" ||
    !keyId ||
    !/^\d+$/u.test(epoch ?? "") ||
    !/^\d+$/u.test(sequence ?? "")
  ) {
    return null;
  }
  return {
    epoch: Number(epoch),
    keyId,
    sequence: Number(sequence),
    tag: tag === "" || tag === undefined ? null : tag,
  };
};

interface Row {
  readonly sequence: number;
  readonly tag: string;
  readonly topic: FeedTopic;
  readonly resourceId: string | null;
}

/** Why a cursor cannot resume, or null when every delivery after it is still retained. */
const staleness = (
  cursor: Cursor | null,
  input: {
    readonly keyId: string;
    readonly epoch: number;
    readonly head: number;
    readonly rows: readonly Row[];
  }
): ResetReason | null => {
  if (
    cursor === null ||
    cursor.keyId !== input.keyId ||
    cursor.sequence > input.head
  ) {
    return "invalid";
  }
  if (cursor.epoch !== input.epoch) {
    return "access";
  }
  const oldest = input.rows[0]?.sequence;
  if (cursor.tag !== null) {
    const row = input.rows.find((item) => item.sequence === cursor.sequence);
    if (row) {
      return row.tag === cursor.tag ? null : "invalid";
    }
    return oldest === undefined || cursor.sequence < oldest
      ? "expired"
      : "invalid";
  }
  // Without a tag the cursor sat where no delivery was retained, so nothing at or below it
  // may exist now, and nothing between it and the oldest retained delivery may be missing.
  if (oldest !== undefined && oldest <= cursor.sequence) {
    return "invalid";
  }
  if (cursor.sequence < input.head && oldest !== cursor.sequence + 1) {
    return "expired";
  }
  return null;
};

/** Visible Presence for one viewer, through the same gate HTTP uses. */
export const visiblePresence = (input: {
  readonly people: readonly PersonRecord[];
  readonly viewerId: string;
  readonly now: number;
  readonly presence: typeof Presence.Service;
  readonly libraryFor: (personId: string) => Layer.Layer<Library>;
}) =>
  Effect.gen(function* readPresence() {
    const found: PresenceEntry[] = [];
    for (const person of input.people) {
      if (!canSee(input.people, input.viewerId, person.id)) {
        continue;
      }
      const setId = yield* input.presence
        .currentSetFor(person.id, input.now)
        .pipe(Effect.orElseSucceed(() => null));
      if (setId === null) {
        continue;
      }
      const [set] = yield* Effect.flatMap(Library, (library) =>
        library.byIds([setId])
      ).pipe(
        Effect.provide(input.libraryFor(person.id)),
        Effect.orElseSucceed(() => [])
      );
      if (set) {
        found.push({ personId: person.id, set, username: person.username });
      }
    }
    return found;
  });

const unreadable = () =>
  new LibraryError({ message: "Could not read the feed.", statusCode: 500 });

/**
 * The read side of the change feed. Catch-up rechecks the key and every delivery's access,
 * and a snapshot and its cursor come from one transaction.
 */
export const makeFeed = (input: {
  readonly db: DatabaseClient;
  readonly presence: typeof Presence.Service;
  /** The recipient's own Library, as their Queue reads it over HTTP. */
  readonly libraryFor: (personId: string) => Layer.Layer<Library>;
  /** Another Person's Library, as Presence hydrates it over HTTP. */
  readonly friendLibraryFor: (personId: string) => Layer.Layer<Library>;
  readonly retentionMs?: number | undefined;
}) => {
  const { db } = input;
  const retentionMs = input.retentionMs ?? RETENTION_MS;

  const authorized = (tx: DatabaseClient, recipientId: string, people: readonly PersonRecord[], row: Row) =>
    Effect.gen(function* checkAccess() {
      const resourceId = row.resourceId ?? "";
      switch (row.topic) {
        case "listen-history": {
          return canSee(people, recipientId, resourceId);
        }
        case "playlist": {
          const [playlist] = yield* tx
            .select({ id: playlists.id })
            .from(playlists)
            .where(eq(playlists.id, resourceId))
            .limit(1);
          if (!playlist) {
            return true;
          }
          return Option.isSome(
            yield* resolveEditablePlaylist({
              id: resourceId,
              people,
              personId: recipientId,
            }).pipe(Effect.option)
          );
        }
        case "set": {
          return Option.isSome(
            yield* resolveVisibleSet({
              id: resourceId,
              people,
              personId: recipientId,
            }).pipe(Effect.option)
          );
        }
        default: {
          return true;
        }
      }
    });

  // The daily key's Person and authorization epoch as this transaction sees them, or null
  // once the key is revoked or the Person removed.
  const recipientOf = (tx: DatabaseClient, keyId: string) =>
    Effect.gen(function* readRecipient() {
      const [key] = yield* tx
        .select({ personId: apiKeys.personId })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.scope, "daily")))
        .limit(1);
      const people = yield* readPeople(tx);
      const person = people.find(
        (candidate) => candidate.id === key?.personId && !candidate.removed
      );
      if (!person) {
        return null;
      }
      const [recipient] = yield* tx
        .select()
        .from(feedRecipients)
        .where(eq(feedRecipients.personId, person.id))
        .limit(1);
      return {
        epoch: recipient?.authorizationEpoch ?? 0,
        head: recipient?.sequence ?? 0,
        people,
        person,
      };
    });

  /** What a feed ticket binds: the key's Person and current authorization epoch. */
  const authorize = (keyId: string) =>
    db
      .transaction((tx) => recipientOf(tx, keyId))
      .pipe(
        Effect.map((found) =>
          found === null
            ? null
            : { authorizationEpoch: found.epoch, personId: found.person.id }
        ),
        Effect.mapError(unreadable)
      );

  const catchUp = (request: {
    readonly keyId: string;
    readonly cursor: string | null;
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* readFeed() {
          const found = yield* recipientOf(tx, request.keyId);
          if (found === null) {
            return { kind: "closed" as const };
          }
          const { epoch, head, people, person } = found;
          const now = Date.now();
          yield* tx
            .delete(feedDeliveries)
            .where(
              and(
                eq(feedDeliveries.personId, person.id),
                lte(feedDeliveries.recordedAt, now - retentionMs)
              )
            );
          const rows: readonly Row[] = yield* tx
            .select({
              resourceId: feedDeliveries.resourceId,
              sequence: feedDeliveries.sequence,
              tag: feedDeliveries.tag,
              topic: feedDeliveries.topic,
            })
            .from(feedDeliveries)
            .where(eq(feedDeliveries.personId, person.id))
            .orderBy(asc(feedDeliveries.sequence));
          const last = rows.at(-1);
          const ready = encodeCursor({
            epoch,
            keyId: request.keyId,
            sequence: head,
            tag: last?.sequence === head ? last.tag : null,
          });
          const queue = () =>
            readListeningQueue(person.id).pipe(
              Effect.provide(input.libraryFor(person.id))
            );
          const presence = () =>
            visiblePresence({
              libraryFor: input.friendLibraryFor,
              now,
              people,
              presence: input.presence,
              viewerId: person.id,
            });

          const cursor =
            request.cursor === null ? null : decodeCursor(request.cursor);
          const reset =
            request.cursor === null
              ? null
              : staleness(cursor, { epoch, head, keyId: request.keyId, rows });
          if (request.cursor === null || reset !== null || cursor === null) {
            return {
              kind: "snapshot" as const,
              reset,
              snapshot: {
                cursor: ready,
                presence: yield* presence(),
                queue: yield* queue(),
              },
            };
          }

          const latest = new Map<string, Row>();
          for (const row of rows) {
            if (row.sequence > cursor.sequence) {
              const collapseKey =
                row.topic === "queue" || row.topic === "presence"
                  ? row.topic
                  : `${row.topic}:${row.resourceId ?? ""}`;
              latest.delete(collapseKey);
              latest.set(collapseKey, row);
            }
          }
          const deliveries: FeedDelivery[] = [];
          for (const row of latest.values()) {
            if (!(yield* authorized(tx, person.id, people, row))) {
              continue;
            }
            const deliveryCursor = encodeCursor({
              epoch,
              keyId: request.keyId,
              sequence: row.sequence,
              tag: row.tag,
            });
            let body: FeedBody;
            if (row.topic === "queue") {
              body = { kind: "queue", queue: yield* queue() };
            } else if (row.topic === "presence") {
              body = { kind: "presence", presence: yield* presence() };
            } else {
              body =
                row.resourceId === null
                  ? { kind: "invalidate", topic: row.topic }
                  : { kind: "invalidate", resourceId: row.resourceId, topic: row.topic };
            }
            deliveries.push({ body, cursor: deliveryCursor });
          }
          return { cursor: ready, deliveries, kind: "changes" as const };
        }).pipe(Effect.provideService(Database, db))
      )
      .pipe(
        Effect.map((result): CatchUp => result),
        Effect.mapError(unreadable)
      );

  return { authorize, catchUp };
};

export type Feed = ReturnType<typeof makeFeed> & {
  readonly subscribe: (listener: (notice: FeedNotice) => void) => () => void;
};
