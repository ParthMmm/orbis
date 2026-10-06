import { and, eq, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { feedDeliveries, feedRecipients } from "./db/schema.js";
import type { feedTopics } from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";
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

/** What a domain owner records inside its mutation transaction. */
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

export type FeedNotice =
  | { readonly kind: "changed"; readonly personId: string }
  | { readonly kind: "revoked"; readonly keyId: string };

export interface JournalOptions {
  readonly retentionMs?: number;
  readonly retentionCount?: number;
  /** Sees every change as it is recorded. Tests use it to watch Presence transitions. */
  readonly observe?: (change: FeedChange) => void;
}

const journalFailure = () =>
  new LibraryError({
    message: "Could not record the change.",
    statusCode: 500,
  });

/** Wakes feed readers after a commit. A notice says only that a Person's journal may have moved. */
export class FeedSignals extends Context.Service<
  FeedSignals,
  {
    readonly publish: (notices: readonly FeedNotice[]) => Effect.Effect<void>;
    readonly subscribe: (listener: (notice: FeedNotice) => void) => () => void;
  }
>()("@orbis/FeedSignals") {
  static make(): typeof FeedSignals.Service {
    const listeners = new Set<(notice: FeedNotice) => void>();
    return {
      publish: (notices) =>
        Effect.forEach(notices, (notice) =>
          Effect.forEach(listeners, (listener) =>
            Effect.try(() => listener(notice)).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("feed listener failed").pipe(
                  Effect.annotateLogs({ cause: String(cause) })
                )
              )
            )
          )
        ).pipe(Effect.asVoid),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }

  static readonly layer = Layer.sync(FeedSignals, () => FeedSignals.make());
}


/** The notices of one outermost journal transaction, published once it commits. */
export class JournalCommit extends Context.Service<
  JournalCommit,
  { readonly changed: Set<string>; readonly revoked: Set<string> }
>()("@orbis/JournalCommit") {}

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
        .map((row) => row.playlistId)
        .sort((left, right) => left.localeCompare(right));
      prints.set(viewer.id, `${visible.join(",")}|${playlistIds.join(",")}`);
    }
    return prints;
  });

/**
 * The one write interface of the change feed. Every domain owner records its changes inside
 * its own mutation transaction, so a mutation and its deliveries commit or roll back together.
 */
export class Journal extends Context.Service<
  Journal,
  {
    /** Opens a journal transaction, or joins the one already open, and publishes notices after the outermost commit. */
    readonly transaction: <A, E, R>(
      body: (tx: DatabaseClient) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SqlError, Exclude<R, JournalCommit>>;
    readonly record: (
      tx: DatabaseClient,
      change: FeedChange
    ) => Effect.Effect<void, LibraryError, JournalCommit>;
    /** Runs a write that can change who sees whom, and resets every Person whose view changed. */
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
            Effect.mapError((error) =>
              error instanceof LibraryError ? error : journalFailure()
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
                    const commit = { changed: new Set<string>(), revoked: new Set<string>() };
                    const result = yield* db
                      .transaction(body)
                      .pipe(Effect.provideService(JournalCommit, commit));
                    yield* signals.publish([
                      ...[...commit.revoked].map(
                        (keyId): FeedNotice => ({ keyId, kind: "revoked" })
                      ),
                      ...[...commit.changed].map(
                        (personId): FeedNotice => ({ kind: "changed", personId })
                      ),
                    ]);
                    return result;
                  }),
                onSome: (commit) =>
                  db.transaction(body).pipe(Effect.provideService(JournalCommit, commit)),
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

        const recipients = (change: Exclude<FeedChange, { topic: "revoked" }>) =>
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
                return yield* playlistReaders(yield* readPeople(db), change.playlistId);
              }
              case "set": {
                return yield* setReaders(yield* readPeople(db), change.setId);
              }
              default: {
                return [];
              }
            }
          });

        const resourceOf = (change: Exclude<FeedChange, { topic: "revoked" }>) => {
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

        const bump = (tx: DatabaseClient, personId: string) =>
          Effect.gen(function* resetRecipient() {
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
            yield* tx.delete(feedDeliveries).where(eq(feedDeliveries.personId, personId));
            commit.changed.add(personId);
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
            for (const personId of new Set([...before.keys(), ...after.keys()])) {
              if (before.get(personId) !== after.get(personId)) {
                yield* guarded(bump(tx, personId));
              }
            }
            return result;
          });

        return { changingAccess, record, transaction };
      })
    );
  }
}

/** A journal for a runtime whose commits no feed reader is waiting on; catch-up still reads its rows. */
export const detachedJournal = (options: JournalOptions = {}) =>
  Journal.layer(options).pipe(Layer.provide(FeedSignals.layer));
