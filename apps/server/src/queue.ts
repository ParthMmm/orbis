import type { ListeningQueue, QueuePlacement } from "@orbis/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Stream } from "effect";
import { Context, Effect, Layer } from "effect";

import { insertBatches } from "./db/batches.js";
import { playlistSets, playlists, queueEntries } from "./db/schema.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";
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

const placedBefore = (
  ids: readonly string[],
  id: string,
  before: string | null
) => {
  const at = before === null ? -1 : ids.indexOf(before);
  return at === -1 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)];
};

export class Queue extends Context.Service<
  Queue,
  {
    readonly changes: Stream.Stream<boolean>;
    readonly notify: () => Effect.Effect<void>;
    readonly read: () => Effect.Effect<ListeningQueue, LibraryError>;
    readonly play: (id: string) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly insert: (
      id: string,
      placement: QueuePlacement
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly replaceWithPlaylist: (
      playlistId: string,
      creatorId?: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly complete: (
      id: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
  }
>()("@orbis/Queue") {
  static readonly scopedLayer = Layer.effect(
    Queue,
    Effect.gen(function* buildQueue() {
      const db = yield* Database;
      const library = yield* Library;
      const stats = yield* Stats;
      const presence = yield* Presence;
      const personId = yield* LibraryPerson;
      const signals = yield* QueueSignals;
      const notify = () => signals.publish(personId);

      const order = () =>
        db
          .select({
            isActive: queueEntries.isActive,
            setId: queueEntries.setId,
          })
          .from(queueEntries)
          .where(eq(queueEntries.personId, personId))
          .orderBy(asc(queueEntries.position));

      const read = Effect.fn("Queue.read")(() =>
        Effect.gen(function* readQueue() {
          const rows = yield* execute(order());
          return {
            activeSetId: activeIn(rows),
            entries: yield* library.byIds(rows.map((row) => row.setId)),
          } satisfies ListeningQueue;
        })
      );

      const writeQueue = (ids: readonly string[], activeSetId: string | null) =>
        Effect.gen(function* replaceEntries() {
          const previous = yield* order();
          yield* db.transaction((tx) =>
            Effect.gen(function* writeQueueTransaction() {
              yield* presence.queueActivated(tx, personId, activeSetId);
              yield* tx
                .delete(queueEntries)
                .where(eq(queueEntries.personId, personId));
              const rows = ids.map((setId, position) => ({
                isActive: setId === activeSetId,
                personId,
                position,
                setId,
              }));
              for (const batch of insertBatches(queueEntries, rows)) {
                yield* tx.insert(queueEntries).values(batch);
              }
            })
          );
          yield* presence.afterCommit();
          yield* Effect.forEach(
            previous.filter((row) => !ids.includes(row.setId)),
            (row) => library.release(row.setId)
          );
        });

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
          const rows = yield* execute(order());
          const activeSetId = activeIn(rows);
          const ids = rows.map((row) => row.setId);
          const next = ids.includes(id)
            ? ids
            : placedBefore(ids, id, activeSetId);
          yield* execute(writeQueue(next, id));
          if (activeSetId !== id) {
            yield* stats.recordListen(id);
          }
          return yield* read().pipe(Effect.tap(notify));
        })
      );

      const insert = Effect.fn("Queue.insert")(
        (id: string, placement: QueuePlacement) =>
          Effect.gen(function* insertEntry() {
            yield* playable(id);
            const rows = yield* execute(order());
            const activeSetId = activeIn(rows);
            if (activeSetId === id) {
              return yield* read().pipe(Effect.tap(notify));
            }
            const rest = rows
              .map((row) => row.setId)
              .filter((setId) => setId !== id);
            const next =
              placement === "end"
                ? [...rest, id]
                : placedAfter(rest, id, activeSetId);
            yield* execute(writeQueue(next, activeSetId));
            return yield* read().pipe(Effect.tap(notify));
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
            const rows = yield* execute(order());
            const previousActive = activeIn(rows);
            const playableMembers = members.filter(
              (set) => set.downloadState === "ready"
            );
            const activeSetId = playableMembers[0]?.id ?? null;
            yield* execute(
              writeQueue(
                playableMembers.map((set) => set.id),
                activeSetId
              )
            );
            if (activeSetId !== null && activeSetId !== previousActive) {
              yield* stats.recordListen(activeSetId);
            }
            return yield* read().pipe(Effect.tap(notify));
          })
      );

      const complete = Effect.fn("Queue.complete")((id: string) =>
        Effect.gen(function* completeSet() {
          const rows = yield* execute(order());
          const at = rows.findIndex((row) => row.isActive && row.setId === id);
          if (at === -1) {
            return yield* read().pipe(Effect.tap(notify));
          }
          const ids = rows.map((row) => row.setId);
          const nextActive = ids[at + 1] ?? null;
          yield* library.setPlaybackPosition(id, 0);
          yield* execute(
            writeQueue(
              ids.filter((setId) => setId !== id),
              nextActive
            )
          );
          yield* stats.recordFinish(id);
          if (nextActive !== null) {
            yield* stats.recordListen(nextActive);
          }
          return yield* read().pipe(Effect.tap(notify));
        })
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
