import { Effect, Stream } from "effect";

import { callOrbis } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

type EventsClient = Parameters<Parameters<typeof callOrbis>[1]>[0];
type LiveEvent =
  Effect.Success<
    ReturnType<EventsClient["events"]["subscribe"]>
  > extends Stream.Stream<infer A, infer _E, infer _R>
    ? A
    : never;

export type ListeningQueue = Extract<LiveEvent, { kind: "queue" }>["queue"];
export type Presence = Extract<LiveEvent, { kind: "presence" }>["presence"];

export interface LiveEventHandlers {
  readonly onPresence: (presence: Presence) => void;
  readonly onQueue: (queue: ListeningQueue) => void;
}

/**
 * Reads `GET /events` until the stream ends or `signal` aborts. It resolves when the
 * stream closes, so the caller decides whether to reconnect (ADR 0014).
 */
export const readLiveEvents = (
  credentials: Credentials,
  handlers: LiveEventHandlers,
  signal: AbortSignal
): Promise<ApiResult<void>> =>
  callOrbis(
    credentials,
    (client) =>
      Effect.gen(function* receiveEvents() {
        const events = yield* client.events.subscribe();
        yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.kind === "queue") {
                handlers.onQueue(event.queue);
              } else if (event.kind === "presence") {
                handlers.onPresence(event.presence);
              }
            })
          )
        );
      }),
    signal
  );
