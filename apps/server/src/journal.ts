import { and, eq, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { feedDeliveries, feedRecipients } from "./db/schema.js";
import type { feedTopics } from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import { FeedSignals } from "./feed-signals.js";
import type { FeedNotice } from "./feed-signals.js";
import type { PersonRecord } from "./identity.js";
import { JournalCommit } from "./journal-commit.js";
import {
  canSee,
  editorAccess,
  playlistReaders,
  readPeople,
  setReaders,
  viewersOf,
} from "./visibility.js";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_COUNT = 10_000;

export type FeedTopic = (typeof feedTopics)[number];

export interface PresenceTransition {
  readonly personId: string;
  readonly cause:
    | "play"
    | "pause"
    | "stop"
    | "renew"
    | "supersede"
    | "expiry"
    | "legacy-report"
    | "legacy-expiry"
    | "queue"
    | "revocation"
    | "removal";
  readonly visibleSetBefore: string | null;
  readonly visibleSetAfter: string | null;
}

export type FeedChange =
  | { readonly topic: "queue"; readonly personId: string }
  | {
      readonly topic: "library";
      readonly personId: string;
      readonly setId: string | null;
    }
  | ({ readonly topic: "presence" } & PresenceTransition)
  | { readonly topic: "listen-history"; readonly personId: string }
  | { readonly topic: "playlist"; readonly playlistId: string }
  | { readonly topic: "set"; readonly setId: string }
  | { readonly topic: "revoked"; readonly keyId: string };

type DeliveredChange = Exclude<FeedChange, { topic: "revoked" }>;

const resourceOf = (change: DeliveredChange) => {
  switch (change.topic) {
    case "library": {
      return change.setId;
    }
    case "listen-history": {
      return change.personId;
    }
    case "playlist": {
      return change.playlistId;
    }
    case "set": {
      return change.setId;
    }
    default: {
      return null;
    }
  }
};

export interface JournalOptions {
  readonly retentionMs?: number;
  readonly retentionCount?: number;
  readonly observe?: (change: FeedChange) => void;
}

const journalFailure = () =>
  new LibraryError({
    message: "Could not record the change.",
    statusCode: 500,
  });

const tag = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

const accessFingerprints = (people: readonly PersonRecord[]) =>
  Effect.gen(function* readAccess() {
    const editable = yield* editorAccess(people);
    const prints = new Map<string, string>();
    for (const viewer of people) {
      const visible = people
        .filter((target) => canSee(people, viewer.id, target.id))
        .map((target) => target.id);
      const playlistIds = editable
        .filter((row) => row.editorId === viewer.id)
        .map((row) => row.playlistId);
      prints.set(viewer.id, `${visible.join(",")}|${playlistIds.join(",")}`);
    }
    return prints;
  });

const resetRecipient = (tx: DatabaseClient, personId: string) =>
  Effect.gen(function* clearRecipient() {
    const commit = yield* JournalCommit;
    yield* tx
      .insert(feedRecipients)
      .values({ authorizationEpoch: 1, personId, sequence: 0 })
      .onConflictDoUpdate({
        set: {
          authorizationEpoch: sql`${feedRecipients.authorizationEpoch} + 1`,
        },
        target: feedRecipients.personId,
      });
    yield* tx
      .delete(feedDeliveries)
      .where(eq(feedDeliveries.personId, personId));
    commit.changed.add(personId);
  });

export class Journal extends Context.Service<
  Journal,
  {
    readonly transaction: <A, E, R>(
      body: (tx: DatabaseClient) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SqlError, Exclude<R, JournalCommit>>;
    readonly record: (
      tx: DatabaseClient,
      change: FeedChange
    ) => Effect.Effect<void, LibraryError, JournalCommit>;
    readonly changingAccess: <A, E, R>(
      tx: DatabaseClient,
      mutate: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | LibraryError, R | JournalCommit>;
  }
>()("@orbis/Journal") {
  static layer(options: JournalOptions = {}) {
    return Layer.effect(
      Journal,
      Effect.gen(function* buildJournal() {
        const db = yield* Database;
        const signals = yield* FeedSignals;
        const retentionMs = options.retentionMs ?? RETENTION_MS;
        const retentionCount = options.retentionCount ?? RETENTION_COUNT;
        const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(Database, db),
            Effect.mapError((failure) =>
              failure instanceof LibraryError ? failure : journalFailure()
            )
          );

        const transaction = <A, E, R>(
          body: (tx: DatabaseClient) => Effect.Effect<A, E, R>
        ): Effect.Effect<A, E | SqlError, Exclude<R, JournalCommit>> =>
          Effect.serviceOption(JournalCommit).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.gen(function* commitAndPublish() {
                    const commit = {
                      changed: new Set<string>(),
                      revoked: new Set<string>(),
                    };
                    const result = yield* db
                      .transaction(body)
                      .pipe(Effect.provideService(JournalCommit, commit));
                    yield* signals.publish([
                      ...[...commit.revoked].map((keyId): FeedNotice => ({
                        keyId,
                        kind: "revoked",
                      })),
                      ...[...commit.changed].map((personId): FeedNotice => ({
                        kind: "changed",
                        personId,
                      })),
                    ]);
                    return result;
                  }),
                onSome: (commit) =>
                  db
                    .transaction(body)
                    .pipe(Effect.provideService(JournalCommit, commit)),
              })
            )
          );

        const deliver = (
          tx: DatabaseClient,
          personId: string,
          topic: FeedTopic,
          resourceId: string | null
        ) =>
          Effect.gen(function* insertDelivery() {
            const commit = yield* JournalCommit;
            const now = Date.now();
            const [recipient] = yield* tx
              .insert(feedRecipients)
              .values({ authorizationEpoch: 0, personId, sequence: 1 })
              .onConflictDoUpdate({
                set: { sequence: sql`${feedRecipients.sequence} + 1` },
                target: feedRecipients.personId,
              })
              .returning({ sequence: feedRecipients.sequence });
            const sequence = recipient?.sequence ?? 1;
            yield* tx.insert(feedDeliveries).values({
              personId,
              recordedAt: now,
              resourceId,
              sequence,
              tag: tag(),
              topic,
            });
            yield* tx
              .delete(feedDeliveries)
              .where(
                and(
                  eq(feedDeliveries.personId, personId),
                  or(
                    lte(feedDeliveries.sequence, sequence - retentionCount),
                    lte(feedDeliveries.recordedAt, now - retentionMs)
                  )
                )
              );
            commit.changed.add(personId);
          });

        const recipients = (change: DeliveredChange) =>
          Effect.gen(function* resolveRecipients() {
            switch (change.topic) {
              case "queue":
              case "library": {
                return [change.personId];
              }
              case "presence":
              case "listen-history": {
                return viewersOf(yield* readPeople(db), change.personId);
              }
              case "playlist": {
                return yield* playlistReaders(
                  yield* readPeople(db),
                  change.playlistId
                );
              }
              case "set": {
                return yield* setReaders(yield* readPeople(db), change.setId);
              }
              default: {
                return [];
              }
            }
          });

        const record = (tx: DatabaseClient, change: FeedChange) =>
          Effect.gen(function* recordChange() {
            options.observe?.(change);
            if (change.topic === "revoked") {
              const commit = yield* JournalCommit;
              commit.revoked.add(change.keyId);
              return;
            }
            const resourceId = resourceOf(change);
            for (const personId of yield* guarded(recipients(change))) {
              yield* guarded(deliver(tx, personId, change.topic, resourceId));
            }
          });

        const changingAccess = <A, E, R>(
          tx: DatabaseClient,
          mutate: Effect.Effect<A, E, R>
        ) =>
          Effect.gen(function* resetChangedViews() {
            const before = yield* guarded(
              Effect.flatMap(readPeople(db), accessFingerprints)
            );
            const result = yield* mutate;
            const after = yield* guarded(
              Effect.flatMap(readPeople(db), accessFingerprints)
            );
            for (const personId of new Set([
              ...before.keys(),
              ...after.keys(),
            ])) {
              if (before.get(personId) !== after.get(personId)) {
                yield* guarded(resetRecipient(tx, personId));
              }
            }
            return result;
          });

        return { changingAccess, record, transaction };
      })
    );
  }
}

export const detachedJournal = (options: JournalOptions = {}) =>
  Journal.layer(options).pipe(Layer.provide(FeedSignals.layer));
