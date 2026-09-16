import type { ListeningQueue, QueuePlacement } from "@orbis/contracts";
import { asc } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { Database } from "./db/database.js";
import { queueEntries } from "./db/schema.js";
import { LibraryError } from "./errors.js";
import { Library } from "./library.js";
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
 * The one Listening Queue, and the Listen it keeps open.
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
    readonly read: () => Effect.Effect<ListeningQueue, LibraryError>;
    /** Makes a Set the active one, which is what tapping a playable Set does. */
    readonly play: (id: string) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly insert: (
      id: string,
      placement: QueuePlacement
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    readonly replaceWithPlaylist: (
      playlistId: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
    /** Removes the finished Set, resets its position, and starts what followed it. */
    readonly complete: (
      id: string
    ) => Effect.Effect<ListeningQueue, LibraryError>;
  }
>()("@orbis/Queue") {
  static readonly layer = Layer.effect(
    Queue,
    Effect.gen(function* buildQueue() {
      const db = yield* Database;
      const library = yield* Library;
      const stats = yield* Stats;

      const order = () =>
        db
          .select({
            isActive: queueEntries.isActive,
            setId: queueEntries.setId,
          })
          .from(queueEntries)
          .orderBy(asc(queueEntries.position));

      const read = Effect.fn("Queue.read")(() =>
        Effect.gen(function* readQueue() {
          const rows = yield* execute(order());
          return {
            activeSetId: rows.find((row) => row.isActive)?.setId ?? null,
            entries: yield* library.byIds(rows.map((row) => row.setId)),
          } satisfies ListeningQueue;
        })
      );

      // Every change states the whole queue. One person's queue is small, the write is one
      // transaction, and positions stay consecutive instead of drifting into gaps that need
      // renumbering later.
      const writeQueue = (ids: readonly string[], activeSetId: string | null) =>
        db.transaction((tx) =>
          Effect.gen(function* writeQueueTransaction() {
            yield* tx.delete(queueEntries);
            if (ids.length > 0) {
              yield* tx.insert(queueEntries).values(
                ids.map((setId, position) => ({
                  isActive: setId === activeSetId,
                  position,
                  setId,
                }))
              );
            }
          })
        );

      // The one check that keeps an unplayable Set out of the queue. A Playlist is filtered
      // instead, because a Playlist is not wrong to play just because one member has no audio.
      const playable = (id: string) =>
        Effect.gen(function* requirePlayable() {
          const set = yield* library.find(id);
          if (set.downloadState !== "ready") {
            return yield* Effect.fail(notPlayable());
          }
          return set;
        });

      const play = Effect.fn("Queue.play")((id: string) =>
        Effect.gen(function* playSet() {
          yield* playable(id);
          const rows = yield* execute(order());
          const activeSetId = rows.find((row) => row.isActive)?.setId ?? null;
          const ids = rows.map((row) => row.setId);
          // A Set already in the queue takes the active place without moving: the queue behind it
          // is the order the person made. A Set that is not in the queue takes the active place
          // where the listening had reached, so nothing is dropped and the Set that was playing
          // becomes what plays next.
          const next = ids.includes(id)
            ? ids
            : placedBefore(ids, id, activeSetId);
          yield* execute(writeQueue(next, id));
          if (activeSetId !== id) {
            yield* stats.recordListen(id);
          }
          return yield* read();
        })
      );

      const insert = Effect.fn("Queue.insert")(
        (id: string, placement: QueuePlacement) =>
          Effect.gen(function* insertEntry() {
            yield* playable(id);
            const rows = yield* execute(order());
            const activeSetId = rows.find((row) => row.isActive)?.setId ?? null;
            // Moving the Set that is playing now would leave the open Listen beside a queue it no
            // longer matches, so a queued action on the active Set changes nothing.
            if (activeSetId === id) {
              return yield* read();
            }
            const rest = rows
              .map((row) => row.setId)
              .filter((setId) => setId !== id);
            const next =
              placement === "end"
                ? [...rest, id]
                : placedAfter(rest, id, activeSetId);
            yield* execute(writeQueue(next, activeSetId));
            return yield* read();
          })
      );

      const replaceWithPlaylist = Effect.fn("Queue.replaceWithPlaylist")(
        (playlistId: string) =>
          Effect.gen(function* replaceQueueFromPlaylist() {
            // A Playlist that does not exist fails here with the Library's own 404.
            const members = yield* library.list({
              playlistId,
              q: "",
              tags: [],
            });
            const rows = yield* execute(order());
            const previousActive =
              rows.find((row) => row.isActive)?.setId ?? null;
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
            return yield* read();
          })
      );

      const complete = Effect.fn("Queue.complete")((id: string) =>
        Effect.gen(function* completeSet() {
          const rows = yield* execute(order());
          const at = rows.findIndex((row) => row.isActive && row.setId === id);
          // A Set that is not the active one was already finished, or the person started
          // something else while it played. Either way this signal adds nothing.
          if (at === -1) {
            return yield* read();
          }
          const ids = rows.map((row) => row.setId);
          const nextActive = ids[at + 1] ?? null;
          yield* execute(
            writeQueue(
              ids.filter((setId) => setId !== id),
              nextActive
            )
          );
          yield* stats.recordFinish(id);
          // A finished Set starts from the beginning next time.
          yield* library.setPlaybackPosition(id, 0);
          // The Set that takes over was not being listened to until now, so it opens its own
          // Listen. An empty queue opens nothing, and playback stops.
          if (nextActive !== null) {
            yield* stats.recordListen(nextActive);
          }
          return yield* read();
        })
      );

      return { complete, insert, play, read, replaceWithPlaylist };
    })
  );
}
