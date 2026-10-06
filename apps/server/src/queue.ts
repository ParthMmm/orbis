import type { ListeningQueue, QueuePlacement } from "@orbis/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Stream } from "effect";
import { Context, Effect, Layer } from "effect";

import { playlistSets, playlists, queueEntries } from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { JournalCommit } from "./journal-commit.js";
import { Journal } from "./journal.js";
import { LibraryPerson } from "./library-person.js";
import { Library } from "./library.js";
import { Presence } from "./presence.js";
import { QueueSignals } from "./queue-signals.js";
import { Stats } from "./stats.js";

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the library request.",
    statusCode: 500,
  });

const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();

const execute = <A, E>(operation: Effect.Effect<A, E>) =>
  operation.pipe(Effect.mapError(toLibraryError));

const notPlayable = () =>
  new LibraryError({
    message: "Only sets with audio can be added to the queue.",
    statusCode: 400,
  });

interface QueueRow {
  readonly isActive: boolean;
  readonly setId: string;
}

const activeIn = (rows: readonly QueueRow[]) =>
  rows.find((row) => row.isActive)?.setId ?? null;

const entriesOf = (db: DatabaseClient, personId: string) =>
  db
    .select({
      isActive: queueEntries.isActive,
      setId: queueEntries.setId,
    })
    .from(queueEntries)
    .where(eq(queueEntries.personId, personId))
    .orderBy(asc(queueEntries.position));

export const readListeningQueue = (personId: string) =>
  Effect.gen(function* readQueue() {
    const db = yield* Database;
    const library = yield* Library;
    const rows = yield* execute(entriesOf(db, personId));
    return {
      activeSetId: activeIn(rows),
      entries: yield* library.byIds(rows.map((row) => row.setId)),
    } satisfies ListeningQueue;
  });

/**
 * Where a Set goes when it joins a queue behind the active entry.
 */
const placedAfter = (
  ids: readonly string[],
  id: string,
  after: string | null
) => {
  const at = after === null ? -1 : ids.indexOf(after);
  return at === -1
    ? [...ids, id]
    : [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)];
};

/**
 * Where a Set goes when it takes the active place from the Set playing now.
 */
const placedBefore = (
  ids: readonly string[],
  id: string,
  before: string | null
) => {
  const at = before === null ? -1 : ids.indexOf(before);
  return at === -1 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)];
};

/**
 * One Person's Listening Queue, and the Listen it keeps open.
 *
 * An entry is a Set waiting to play, and the entry marked active is the Set playing now. The
 * queue is the whole of the playback state: which Set is playing, what follows it, and — because
 * the active entry is the Listen — whether a completion signal is the first one for this Listen.
 * Counting from a stored state rather than from reported events is what makes a retried signal
 * from the other device do nothing.
 */
export class Queue extends Context.Service<
  Queue,
  {
    readonly changes: Stream.Stream<boolean>;
    readonly notify: () => Effect.Effect<void>;
    readonly read: () => Effect.Effect<ListeningQueue, LibraryError>;
    /** Makes a Set the active one, which is what tapping a playable Set does. */
    readonly play: (id: string) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly insert: (
      id: string,
      placement: QueuePlacement
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly replaceWithPlaylist: (
      playlistId: string,
      creatorId?: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Removes the finished Set, resets its position, and starts what followed it. */
    readonly complete: (
      id: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
  }
>()("@orbis/Queue") {
  static readonly scopedLayer = Layer.effect(
    Queue,
    Effect.gen(function* buildQueue() {
      const db = yield* Database;
      const journal = yield* Journal;
      const library = yield* Library;
      const stats = yield* Stats;
      const presence = yield* Presence;
      const personId = yield* LibraryPerson;
      const signals = yield* QueueSignals;
      const notify = () => signals.publish(personId);

      const order = () => entriesOf(db, personId);

      const read = Effect.fn("Queue.read")(() =>
        readListeningQueue(personId).pipe(
          Effect.provideService(Database, db),
          Effect.provideService(Library, library)
        )
      );

      // Every change states the whole queue. One person's queue is small, and positions stay
      // consecutive instead of drifting into gaps that need renumbering later.
      const writeQueue = (
        tx: DatabaseClient,
        rows: readonly QueueRow[],
        ids: readonly string[],
        activeSetId: string | null
      ) =>
        Effect.gen(function* replaceEntries() {
          yield* presence.queueActivated(tx, personId, activeSetId);
          yield* tx
            .delete(queueEntries)
            .where(eq(queueEntries.personId, personId));
          if (ids.length > 0) {
            yield* tx.insert(queueEntries).values(
              ids.map((setId, position) => ({
                isActive: setId === activeSetId,
                personId,
                position,
                setId,
              }))
            );
          }
          yield* journal.record(tx, { personId, topic: "queue" });
          return rows
            .map((row) => row.setId)
            .filter((setId) => !ids.includes(setId));
        });

      const mutate = <E>(
        change: (
          tx: DatabaseClient,
          rows: readonly QueueRow[]
        ) => Effect.Effect<readonly string[] | "unchanged", E, JournalCommit>
      ) =>
        Effect.gen(function* commitQueueChange() {
          const released = yield* execute(
            journal.transaction((tx) =>
              Effect.flatMap(order(), (rows) => change(tx, rows))
            )
          );
          if (released !== "unchanged") {
            yield* presence.afterCommit();
            yield* Effect.all(released.map((setId) => library.release(setId)));
          }
          return yield* read().pipe(Effect.tap(notify));
        });

      // The one check that keeps an unplayable Set out of the queue. A Playlist is filtered
      // instead, because a Playlist is not wrong to play just because one member has no audio.
      const playable = (id: string) =>
        Effect.gen(function* requirePlayable() {
          const [set] = yield* library.byIds([id]);
          if (!set) {
            return yield* Effect.fail(
              new LibraryError({ message: "Set not found.", statusCode: 404 })
            );
          }
          if (set.downloadState !== "ready") {
            return yield* Effect.fail(notPlayable());
          }
          return set;
        });

      const play = Effect.fn("Queue.play")((id: string) =>
        Effect.gen(function* playSet() {
          yield* playable(id);
          return yield* mutate((tx, rows) =>
            Effect.gen(function* activateSet() {
              const activeSetId = activeIn(rows);
              const ids = rows.map((row) => row.setId);
              // A Set already in the queue takes the active place without moving: the queue
              // behind it is the order the person made. A Set that is not in the queue takes the
              // active place where the listening had reached, so nothing is dropped and the Set
              // that was playing becomes what plays next.
              const next = ids.includes(id)
                ? ids
                : placedBefore(ids, id, activeSetId);
              const released = yield* writeQueue(tx, rows, next, id);
              if (activeSetId !== id) {
                yield* stats.recordListen(id);
              }
              return released;
            })
          );
        })
      );

      const insert = Effect.fn("Queue.insert")(
        (id: string, placement: QueuePlacement) =>
          Effect.gen(function* insertEntry() {
            yield* playable(id);
            return yield* mutate((tx, rows) => {
              const activeSetId = activeIn(rows);
              // Moving the Set that is playing now would leave the open Listen beside a queue it
              // no longer matches, so a queued action on the active Set changes nothing.
              if (activeSetId === id) {
                return Effect.succeed("unchanged" as const);
              }
              const rest = rows
                .map((row) => row.setId)
                .filter((setId) => setId !== id);
              const next =
                placement === "end"
                  ? [...rest, id]
                  : placedAfter(rest, id, activeSetId);
              return writeQueue(tx, rows, next, activeSetId);
            });
          })
      );

      const replaceWithPlaylist = Effect.fn("Queue.replaceWithPlaylist")(
        (playlistId: string, creatorId: string = personId) =>
          Effect.gen(function* replaceQueueFromPlaylist() {
            const [playlist] = yield* execute(
              db
                .select({ id: playlists.id })
                .from(playlists)
                .where(
                  and(
                    eq(playlists.id, playlistId),
                    eq(playlists.creatorId, creatorId)
                  )
                )
                .limit(1)
            );
            if (!playlist) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "Playlist not found.",
                  statusCode: 404,
                })
              );
            }
            const memberIds = yield* execute(
              db
                .select({ setId: playlistSets.setId })
                .from(playlistSets)
                .where(eq(playlistSets.playlistId, playlistId))
                .orderBy(asc(playlistSets.position))
            );
            const members = yield* library.byIds(
              memberIds.map((member) => member.setId)
            );
            const playableMembers = members.filter(
              (set) => set.downloadState === "ready"
            );
            const activeSetId = playableMembers[0]?.id ?? null;
            return yield* mutate((tx, rows) =>
              Effect.gen(function* replaceEntriesFromPlaylist() {
                const released = yield* writeQueue(
                  tx,
                  rows,
                  playableMembers.map((set) => set.id),
                  activeSetId
                );
                if (activeSetId !== null && activeSetId !== activeIn(rows)) {
                  yield* stats.recordListen(activeSetId);
                }
                return released;
              })
            );
          })
      );

      const complete = Effect.fn("Queue.complete")((id: string) =>
        mutate((tx, rows) =>
          Effect.gen(function* completeSet() {
            const at = rows.findIndex(
              (row) => row.isActive && row.setId === id
            );
            // A Set that is not the active one was already finished, or the person started
            // something else while it played. Either way this signal adds nothing.
            if (at === -1) {
              return "unchanged" as const;
            }
            const ids = rows.map((row) => row.setId);
            const nextActive = ids[at + 1] ?? null;
            yield* library.setPlaybackPosition(id, 0);
            const released = yield* writeQueue(
              tx,
              rows,
              ids.filter((setId) => setId !== id),
              nextActive
            );
            yield* stats.recordFinish(id);
            // The Set that takes over was not being listened to until now, so it opens its own
            // Listen. An empty queue opens nothing, and playback stops.
            if (nextActive !== null) {
              yield* stats.recordListen(nextActive);
            }
            return released;
          })
        )
      );

      return {
        changes: signals.subscribe(personId),
        complete,
        insert,
        notify,
        play,
        read,
        replaceWithPlaylist,
      };
    })
  );

  static readonly layer = Queue.scopedLayer.pipe(
    Layer.provide(Layer.succeed(LibraryPerson, "host"))
  );

  static forPersonLayer(personId: string) {
    return Layer.fresh(Queue.scopedLayer).pipe(
      Layer.provide(Layer.succeed(LibraryPerson, personId))
    );
  }
}
