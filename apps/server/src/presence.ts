import type { PresenceAction, PresenceActionResult } from "@orbis/contracts";
import { PresenceActionResultSchema } from "@orbis/contracts/http-api";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  lte,
  max,
  ne,
  sql,
} from "drizzle-orm";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Schema,
  Scope,
  Stream,
} from "effect";

import {
  presenceActionResults,
  presenceKeys,
  presenceLegacyReports,
  presenceSessions,
  queueEntries,
} from "./db/schema.js";
import type { DatabaseClient } from "./db/service.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";
import { conflict, PresenceConflict } from "./presence-conflict.js";
import type { ConflictReason } from "./presence-conflict.js";
import { PresenceJournal } from "./presence-journal.js";
import type { PresenceTransition } from "./presence-journal.js";

export const LEASE_MS = 30_000;
export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_WINDOW_MS = 30_000;
/** Session rows one daily key may hold. Revoking the key reclaims them. */
const SESSION_CAP = 10_000;

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the presence request.",
    statusCode: 500,
  });
const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();
const execute = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.mapError(toLibraryError));
/** Keeps the typed refusal so the handler can answer 409 with its reason. */
const executeAction = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(
    Effect.mapError((failure) =>
      failure instanceof PresenceConflict ? failure : toLibraryError(failure)
    )
  );

export interface PresenceCaller {
  readonly keyId: string;
  readonly personId: string;
}

export interface PresenceOptions {
  readonly leaseMs?: number;
  readonly resultRetentionMs?: number;
  /** How long a Playback Position report from a key that never opted in counts as listening. */
  readonly legacyWindowMs?: number;
  /** Wakes `expire` at the nearest deadline; `null` cancels. Bun defaults to a scoped timer. */
  readonly alarm?: {
    readonly set: (at: number | null) => void | Promise<void>;
  };
}

interface SessionFields {
  readonly actionNumber: number;
  readonly keyId: string;
  readonly ownerGeneration: number;
  readonly personId: string;
  readonly sessionId: string;
  readonly setId: string;
}
/** One session row. Only `playing` carries a lease. */
type Session = SessionFields &
  (
    | { readonly state: "playing"; readonly leaseExpiresAt: number }
    | { readonly state: "paused" | "stopped" | "superseded" }
  );
type Decision =
  | { readonly kind: "accept"; readonly next: Session }
  | { readonly kind: "refuse"; readonly reason: ConflictReason };
interface Facts {
  readonly activeSetId: string | null;
  readonly keySessionCount: number;
  readonly leaseExpiresAt: number;
  readonly nextGeneration: number;
}

const refuse = (reason: ConflictReason): Decision => ({
  kind: "refuse",
  reason,
});
const accept = (next: Session): Decision => ({ kind: "accept", next });
const fields = (session: Session): SessionFields => ({
  actionNumber: session.actionNumber,
  keyId: session.keyId,
  ownerGeneration: session.ownerGeneration,
  personId: session.personId,
  sessionId: session.sessionId,
  setId: session.setId,
});

/** The transition table of ADR 0019, with every guard that needs no further read. */
const decide = (
  session: Session | null,
  caller: PresenceCaller,
  action: PresenceAction,
  facts: Facts
): Decision => {
  if (session && action.actionNumber <= session.actionNumber) {
    return refuse("stale");
  }
  if (action.kind === "play") {
    if (session?.state === "stopped") {
      return refuse("stale");
    }
    if (session && session.setId !== action.setId) {
      return refuse("session-set");
    }
    if (facts.activeSetId !== action.setId) {
      return refuse("queue-changed");
    }
    if (!session && facts.keySessionCount >= SESSION_CAP) {
      return refuse("session-limit");
    }
    return accept({
      actionNumber: action.actionNumber,
      keyId: caller.keyId,
      leaseExpiresAt: facts.leaseExpiresAt,
      ownerGeneration: facts.nextGeneration,
      personId: caller.personId,
      sessionId: action.sessionId,
      setId: action.setId,
      state: "playing",
    });
  }
  if (!session || session.ownerGeneration !== action.ownerGeneration) {
    return refuse("stale");
  }
  const owned = session.state === "playing" || session.state === "paused";
  const next = { ...fields(session), actionNumber: action.actionNumber };
  switch (action.kind) {
    case "pause": {
      return owned ? accept({ ...next, state: "paused" }) : refuse("stale");
    }
    case "stop": {
      return owned ? accept({ ...next, state: "stopped" }) : refuse("stale");
    }
    case "renew": {
      return session.state === "playing"
        ? accept({
            ...next,
            leaseExpiresAt: facts.leaseExpiresAt,
            state: "playing",
          })
        : refuse("stale");
    }
    default: {
      return refuse("stale");
    }
  }
};

const toSession = (row: typeof presenceSessions.$inferSelect): Session => {
  const base = {
    actionNumber: row.actionNumber,
    keyId: row.keyId,
    ownerGeneration: row.ownerGeneration,
    personId: row.personId,
    sessionId: row.sessionId,
    setId: row.setId,
  };
  return row.state === "playing"
    ? { ...base, leaseExpiresAt: row.leaseExpiresAt ?? 0, state: "playing" }
    : { ...base, state: row.state };
};

const toContract = (session: Session): PresenceActionResult["session"] => {
  const base = {
    actionNumber: session.actionNumber,
    ownerGeneration: session.ownerGeneration,
    sessionId: session.sessionId,
    setId: session.setId,
  };
  return session.state === "playing"
    ? {
        ...base,
        leaseExpiresAt: new Date(session.leaseExpiresAt).toISOString(),
        state: "playing",
      }
    : { ...base, state: session.state };
};

/** Field order from the client must not decide whether a retry matches. */
const canonical = (action: PresenceAction) =>
  JSON.stringify(action, [
    "actionId",
    "actionNumber",
    "kind",
    "ownerGeneration",
    "sessionId",
    "setId",
  ]);

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(PresenceActionResultSchema)
);

const activeSetFor = (tx: DatabaseClient, personId: string) =>
  tx
    .select({ setId: queueEntries.setId })
    .from(queueEntries)
    .where(
      and(eq(queueEntries.personId, personId), eq(queueEntries.isActive, true))
    )
    .limit(1)
    .pipe(Effect.map(([row]) => row?.setId ?? null));

const supersedeOwner = (
  tx: DatabaseClient,
  personId: string,
  now: number,
  except?: { keyId: string; sessionId: string }
) =>
  tx
    .update(presenceSessions)
    .set({ leaseExpiresAt: null, state: "superseded", updatedAt: now })
    .where(
      and(
        eq(presenceSessions.personId, personId),
        inArray(presenceSessions.state, ["playing", "paused"]),
        except
          ? sql`NOT (${presenceSessions.keyId} = ${except.keyId} AND ${presenceSessions.sessionId} = ${except.sessionId})`
          : undefined
      )
    );

const personOf = (tx: DatabaseClient, keyId: string) =>
  Effect.gen(function* findKeyPerson() {
    const [session] = yield* tx
      .select({ personId: presenceSessions.personId })
      .from(presenceSessions)
      .where(eq(presenceSessions.keyId, keyId))
      .limit(1);
    const [key] = yield* tx
      .select({ personId: presenceKeys.personId })
      .from(presenceKeys)
      .where(eq(presenceKeys.keyId, keyId))
      .limit(1);
    const [report] = yield* tx
      .select({ personId: presenceLegacyReports.personId })
      .from(presenceLegacyReports)
      .where(eq(presenceLegacyReports.keyId, keyId))
      .limit(1);
    return (session ?? key ?? report)?.personId ?? null;
  });

/**
 * The one owner of explicit Presence state (ADR 0019). Every write to the four presence tables
 * goes through here, so the lease, ownership, deduplication, and legacy fallback rules live in
 * one place and every visible change reaches the journal in its committing transaction.
 */
export class Presence extends Context.Service<
  Presence,
  {
    readonly act: (
      caller: PresenceCaller,
      action: PresenceAction
    ) => Effect.Effect<PresenceActionResult, LibraryError | PresenceConflict>;
    /** A legacy Position report. A key that opted into actions changes nothing here. */
    readonly reportPosition: (
      caller: PresenceCaller,
      setId: string
    ) => Effect.Effect<void, LibraryError>;
    /** Called inside the Queue's write transaction, before its rows change. */
    readonly queueActivated: (
      tx: DatabaseClient,
      personId: string,
      activeSetId: string | null
    ) => Effect.Effect<void, LibraryError>;
    readonly revokeKey: (keyId: string) => Effect.Effect<void, LibraryError>;
    readonly removePerson: (
      tx: DatabaseClient,
      personId: string
    ) => Effect.Effect<void, LibraryError>;
    /** Runs at a deadline: lapsed leases pause, lapsed legacy reports drop, the alarm moves on. */
    readonly expire: (now: number) => Effect.Effect<void, LibraryError>;
    readonly currentSetFor: (
      personId: string,
      now: number
    ) => Effect.Effect<string | null, LibraryError>;
    readonly schedule: () => Effect.Effect<void, LibraryError>;
    /** Fires after a commit that may have changed someone's visible Presence. */
    readonly changes: Stream.Stream<boolean>;
  }
>()("@orbis/Presence") {
  static layer(options: PresenceOptions = {}) {
    return Layer.effect(
      Presence,
      Effect.gen(function* buildPresence() {
        const db = yield* Database;
        const journal = yield* PresenceJournal;
        const scope = yield* Scope.Scope;
        const leaseMs = options.leaseMs ?? LEASE_MS;
        const retentionMs = options.resultRetentionMs ?? RESULT_RETENTION_MS;
        const legacyWindowMs = options.legacyWindowMs ?? LEGACY_WINDOW_MS;

        /**
         * The Person's visible Set. Without `now` it trusts the rows, which every transaction
         * settles first; with `now` it also applies the deadlines, for a reader between alarms.
         */
        const visible = (
          tx: DatabaseClient,
          personId: string,
          view: { now?: number; activeSetId?: string | null } = {}
        ) =>
          Effect.gen(function* resolveVisible() {
            const [owner] = yield* tx
              .select({ setId: presenceSessions.setId })
              .from(presenceSessions)
              .where(
                and(
                  eq(presenceSessions.personId, personId),
                  eq(presenceSessions.state, "playing"),
                  view.now === undefined
                    ? undefined
                    : gt(presenceSessions.leaseExpiresAt, view.now)
                )
              )
              .limit(1);
            if (owner) {
              return owner.setId;
            }
            const activeSetId =
              view.activeSetId === undefined
                ? yield* activeSetFor(tx, personId)
                : view.activeSetId;
            if (activeSetId === null) {
              return null;
            }
            const [report] = yield* tx
              .select({ setId: presenceLegacyReports.setId })
              .from(presenceLegacyReports)
              .where(
                and(
                  eq(presenceLegacyReports.personId, personId),
                  eq(presenceLegacyReports.setId, activeSetId),
                  view.now === undefined
                    ? undefined
                    : gt(
                        presenceLegacyReports.reportedAt,
                        view.now - legacyWindowMs
                      )
                )
              )
              .orderBy(desc(presenceLegacyReports.reportedAt))
              .limit(1);
            return report?.setId ?? null;
          });

        const journalIfChanged = (
          tx: DatabaseClient,
          transition: PresenceTransition
        ) =>
          transition.before === transition.after
            ? Effect.void
            : journal.record(tx, transition);

        /** Applies every lapsed deadline, for one Person or all. Idempotent. */
        const settle = (tx: DatabaseClient, now: number, personId?: string) =>
          Effect.gen(function* settleDeadlines() {
            const lapsedLease = and(
              eq(presenceSessions.state, "playing"),
              lte(presenceSessions.leaseExpiresAt, now),
              personId === undefined
                ? undefined
                : eq(presenceSessions.personId, personId)
            );
            const lapsedReport = and(
              lte(presenceLegacyReports.reportedAt, now - legacyWindowMs),
              personId === undefined
                ? undefined
                : eq(presenceLegacyReports.personId, personId)
            );
            const lapsedSessions = yield* tx
              .select({ personId: presenceSessions.personId })
              .from(presenceSessions)
              .where(lapsedLease);
            if (lapsedSessions.length > 0) {
              yield* tx
                .update(presenceSessions)
                .set({ leaseExpiresAt: null, state: "paused", updatedAt: now })
                .where(lapsedLease);
            }
            const lapsedReports = yield* tx
              .select({ personId: presenceLegacyReports.personId })
              .from(presenceLegacyReports)
              .where(lapsedReport);
            if (lapsedReports.length > 0) {
              yield* tx.delete(presenceLegacyReports).where(lapsedReport);
            }
            return {
              leases: new Set(lapsedSessions.map((row) => row.personId)),
              reports: new Set(lapsedReports.map((row) => row.personId)),
            };
          });

        const nearestDeadline = () =>
          Effect.gen(function* readNearestDeadline() {
            const [lease] = yield* db
              .select({
                at: sql<number | null>`min(${presenceSessions.leaseExpiresAt})`,
              })
              .from(presenceSessions)
              .where(eq(presenceSessions.state, "playing"));
            const [report] = yield* db
              .select({
                at: sql<
                  number | null
                >`min(${presenceLegacyReports.reportedAt})`,
              })
              .from(presenceLegacyReports);
            const deadlines = [
              lease?.at ?? null,
              report?.at === null || report?.at === undefined
                ? null
                : report.at + legacyWindowMs,
            ].filter((at): at is number => at !== null);
            return deadlines.length === 0 ? null : Math.min(...deadlines);
          });

        let timer: Fiber.Fiber<void> | null = null;
        let wake: Effect.Effect<void> = Effect.void;
        const bunAlarm = (at: number | null): Effect.Effect<void> =>
          Effect.gen(function* armTimer() {
            if (timer) {
              yield* Fiber.interrupt(timer);
              timer = null;
            }
            if (at === null) {
              return;
            }
            timer = yield* Effect.sleep(
              Duration.millis(Math.max(at - Date.now(), 0))
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  timer = null;
                })
              ),
              Effect.andThen(Effect.suspend(() => wake)),
              Effect.forkIn(scope)
            );
          });
        const { alarm } = options;
        const setAlarm = (at: number | null) =>
          alarm
            ? Effect.promise(() => Promise.resolve(alarm.set(at)))
            : bunAlarm(at);

        const schedule: () => Effect.Effect<void, LibraryError> = Effect.fn(
          "Presence.schedule"
        )(() => execute(Effect.flatMap(nearestDeadline(), setAlarm)));
        const hub = yield* PubSub.sliding<boolean>(1);
        const committed = () =>
          schedule().pipe(
            Effect.andThen(PubSub.publish(hub, true)),
            Effect.asVoid
          );

        const upsert = (tx: DatabaseClient, next: Session, now: number) => {
          const row = {
            ...fields(next),
            leaseExpiresAt:
              next.state === "playing" ? next.leaseExpiresAt : null,
            state: next.state,
            updatedAt: now,
          };
          return tx
            .insert(presenceSessions)
            .values(row)
            .onConflictDoUpdate({
              set: {
                actionNumber: row.actionNumber,
                leaseExpiresAt: row.leaseExpiresAt,
                ownerGeneration: row.ownerGeneration,
                state: row.state,
                updatedAt: row.updatedAt,
              },
              target: [presenceSessions.keyId, presenceSessions.sessionId],
            });
        };

        const gatherFacts = (
          tx: DatabaseClient,
          caller: PresenceCaller,
          now: number
        ) =>
          Effect.gen(function* readFacts() {
            const activeSetId = yield* activeSetFor(tx, caller.personId);
            const [sessions] = yield* tx
              .select({ total: count() })
              .from(presenceSessions)
              .where(eq(presenceSessions.keyId, caller.keyId));
            const [generation] = yield* tx
              .select({ latest: max(presenceSessions.ownerGeneration) })
              .from(presenceSessions)
              .where(eq(presenceSessions.personId, caller.personId));
            return {
              activeSetId,
              keySessionCount: sessions?.total ?? 0,
              leaseExpiresAt: now + leaseMs,
              nextGeneration: (generation?.latest ?? 0) + 1,
            } satisfies Facts;
          });

        const act = Effect.fn("Presence.act")(
          (caller: PresenceCaller, action: PresenceAction) =>
            executeAction(
              db.transaction((tx) =>
                Effect.gen(function* applyAction() {
                  const now = Date.now();
                  const input = canonical(action);
                  const [saved] = yield* tx
                    .select({
                      input: presenceActionResults.input,
                      result: presenceActionResults.result,
                    })
                    .from(presenceActionResults)
                    .where(
                      and(
                        eq(presenceActionResults.keyId, caller.keyId),
                        eq(presenceActionResults.sessionId, action.sessionId),
                        eq(presenceActionResults.actionId, action.actionId),
                        gt(presenceActionResults.recordedAt, now - retentionMs)
                      )
                    )
                    .limit(1);
                  if (saved) {
                    if (saved.input !== input) {
                      return yield* conflict("action-reused");
                    }
                    return {
                      ...decodeResult(saved.result),
                      outcome: "duplicate" as const,
                    };
                  }
                  // A pruned action ID with a higher number is a new action, so the old row goes first.
                  yield* tx
                    .delete(presenceActionResults)
                    .where(
                      and(
                        eq(presenceActionResults.keyId, caller.keyId),
                        lte(presenceActionResults.recordedAt, now - retentionMs)
                      )
                    );
                  const before = yield* visible(tx, caller.personId);
                  yield* settle(tx, now, caller.personId);
                  const [row] = yield* tx
                    .select()
                    .from(presenceSessions)
                    .where(
                      and(
                        eq(presenceSessions.keyId, caller.keyId),
                        eq(presenceSessions.sessionId, action.sessionId)
                      )
                    )
                    .limit(1);
                  const session = row ? toSession(row) : null;
                  const decision = decide(
                    session,
                    caller,
                    action,
                    yield* gatherFacts(tx, caller, now)
                  );
                  if (decision.kind === "refuse") {
                    return yield* conflict(decision.reason);
                  }
                  if (action.kind === "play") {
                    yield* supersedeOwner(tx, caller.personId, now, {
                      keyId: caller.keyId,
                      sessionId: action.sessionId,
                    });
                    yield* tx
                      .insert(presenceKeys)
                      .values({
                        keyId: caller.keyId,
                        optedInAt: now,
                        personId: caller.personId,
                      })
                      .onConflictDoNothing();
                  }
                  yield* upsert(tx, decision.next, now);
                  const result: PresenceActionResult = {
                    outcome: "accepted",
                    session: toContract(decision.next),
                  };
                  yield* tx.insert(presenceActionResults).values({
                    actionId: action.actionId,
                    input,
                    keyId: caller.keyId,
                    recordedAt: now,
                    result: JSON.stringify(result),
                    sessionId: action.sessionId,
                  });
                  const after = yield* visible(tx, caller.personId);
                  yield* journalIfChanged(tx, {
                    after,
                    before,
                    cause: action.kind,
                    personId: caller.personId,
                  });
                  return result;
                })
              )
            ).pipe(
              Effect.tap((result) =>
                result.outcome === "accepted" ? committed() : Effect.void
              )
            )
        );

        const reportPosition = Effect.fn("Presence.reportPosition")(
          (caller: PresenceCaller, setId: string) =>
            execute(
              db.transaction((tx) =>
                Effect.gen(function* recordLegacyReport() {
                  const now = Date.now();
                  const [optedIn] = yield* tx
                    .select({ keyId: presenceKeys.keyId })
                    .from(presenceKeys)
                    .where(eq(presenceKeys.keyId, caller.keyId))
                    .limit(1);
                  if (optedIn) {
                    return false;
                  }
                  const before = yield* visible(tx, caller.personId);
                  yield* settle(tx, now, caller.personId);
                  yield* tx
                    .insert(presenceLegacyReports)
                    .values({
                      keyId: caller.keyId,
                      personId: caller.personId,
                      reportedAt: now,
                      setId,
                    })
                    .onConflictDoUpdate({
                      set: {
                        personId: caller.personId,
                        reportedAt: now,
                        setId,
                      },
                      target: presenceLegacyReports.keyId,
                    });
                  const after = yield* visible(tx, caller.personId);
                  yield* journalIfChanged(tx, {
                    after,
                    before,
                    cause: "legacy-report",
                    personId: caller.personId,
                  });
                  return true;
                })
              )
            ).pipe(
              Effect.flatMap((reported) =>
                reported ? committed() : Effect.void
              )
            )
        );

        const queueActivated = Effect.fn("Presence.queueActivated")(
          (tx: DatabaseClient, personId: string, activeSetId: string | null) =>
            execute(
              Effect.gen(function* supersedeOtherSets() {
                const now = Date.now();
                const before = yield* visible(tx, personId);
                yield* tx
                  .update(presenceSessions)
                  .set({
                    leaseExpiresAt: null,
                    state: "superseded",
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(presenceSessions.personId, personId),
                      inArray(presenceSessions.state, ["playing", "paused"]),
                      activeSetId === null
                        ? undefined
                        : ne(presenceSessions.setId, activeSetId)
                    )
                  );
                const after = yield* visible(tx, personId, { activeSetId });
                yield* journalIfChanged(tx, {
                  after,
                  before,
                  cause: "queue",
                  personId,
                });
              })
            )
        );

        /** Deletes every presence row the key holds, journaling the Person's visible change. */
        const clearKeys = (
          tx: DatabaseClient,
          keyIds: readonly string[],
          personId: string,
          cause: "revocation" | "removal"
        ) =>
          Effect.gen(function* deleteKeyRows() {
            if (keyIds.length === 0) {
              return;
            }
            const before = yield* visible(tx, personId);
            yield* tx
              .delete(presenceActionResults)
              .where(inArray(presenceActionResults.keyId, keyIds));
            yield* tx
              .delete(presenceSessions)
              .where(inArray(presenceSessions.keyId, keyIds));
            yield* tx
              .delete(presenceKeys)
              .where(inArray(presenceKeys.keyId, keyIds));
            yield* tx
              .delete(presenceLegacyReports)
              .where(inArray(presenceLegacyReports.keyId, keyIds));
            const after = yield* visible(tx, personId);
            yield* journalIfChanged(tx, { after, before, cause, personId });
          });

        const revokeKey = Effect.fn("Presence.revokeKey")((keyId: string) =>
          execute(
            db.transaction((tx) =>
              Effect.gen(function* revokeKeyRows() {
                const personId = yield* personOf(tx, keyId);
                if (personId !== null) {
                  yield* clearKeys(tx, [keyId], personId, "revocation");
                }
              })
            )
          ).pipe(Effect.andThen(committed()))
        );

        const removePerson = Effect.fn("Presence.removePerson")(
          (tx: DatabaseClient, personId: string) =>
            execute(
              Effect.gen(function* removePersonRows() {
                const held = yield* Effect.all([
                  tx
                    .select({ keyId: presenceSessions.keyId })
                    .from(presenceSessions)
                    .where(eq(presenceSessions.personId, personId)),
                  tx
                    .select({ keyId: presenceKeys.keyId })
                    .from(presenceKeys)
                    .where(eq(presenceKeys.personId, personId)),
                  tx
                    .select({ keyId: presenceLegacyReports.keyId })
                    .from(presenceLegacyReports)
                    .where(eq(presenceLegacyReports.personId, personId)),
                ]);
                const keyIds = [
                  ...new Set(held.flat().map((row) => row.keyId)),
                ];
                yield* clearKeys(tx, keyIds, personId, "removal");
              })
            )
        );

        const expire: (now: number) => Effect.Effect<void, LibraryError> =
          Effect.fn("Presence.expire")((now: number) =>
            execute(
              db.transaction((tx) =>
                Effect.gen(function* expireDeadlines() {
                  const due = yield* Effect.all([
                    tx
                      .select({ personId: presenceSessions.personId })
                      .from(presenceSessions)
                      .where(
                        and(
                          eq(presenceSessions.state, "playing"),
                          lte(presenceSessions.leaseExpiresAt, now)
                        )
                      ),
                    tx
                      .select({ personId: presenceLegacyReports.personId })
                      .from(presenceLegacyReports)
                      .where(
                        lte(
                          presenceLegacyReports.reportedAt,
                          now - legacyWindowMs
                        )
                      ),
                  ]);
                  const people = [
                    ...new Set(due.flat().map((row) => row.personId)),
                  ];
                  const before = new Map<string, string | null>();
                  for (const personId of people) {
                    before.set(personId, yield* visible(tx, personId));
                  }
                  const lapsed = yield* settle(tx, now);
                  for (const personId of people) {
                    const after = yield* visible(tx, personId);
                    yield* journalIfChanged(tx, {
                      after,
                      before: before.get(personId) ?? null,
                      cause: lapsed.leases.has(personId)
                        ? "expiry"
                        : "legacy-expiry",
                      personId,
                    });
                  }
                })
              )
            ).pipe(Effect.andThen(committed()))
          );

        wake = Effect.suspend(() => expire(Date.now())).pipe(Effect.ignore);

        const currentSetFor = Effect.fn("Presence.currentSetFor")(
          (personId: string, now: number) =>
            execute(visible(db, personId, { now }))
        );

        yield* schedule();

        return {
          act,
          changes: Stream.unwrap(
            Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)
          ),
          currentSetFor,
          expire,
          queueActivated,
          removePerson,
          reportPosition,
          revokeKey,
          schedule,
        };
      })
    );
  }
}
