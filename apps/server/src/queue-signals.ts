import { Context, Effect, Layer, PubSub, Stream } from "effect";

/** Routes invalidations between request-scoped Queues belonging to the same Person. */
export class QueueSignals extends Context.Service<
  QueueSignals,
  {
    readonly publish: (personId: string) => Effect.Effect<void>;
    readonly subscribe: (personId: string) => Stream.Stream<boolean>;
  }
>()("@orbis/QueueSignals") {
  static readonly layer = Layer.sync(QueueSignals, () => {
    const listeners = new Map<
      string,
      { hub: PubSub.PubSub<boolean>; count: number }
    >();
    return {
      publish: (personId) =>
        Effect.gen(function* publishQueueChange() {
          const entry = listeners.get(personId);
          if (entry) {
            yield* PubSub.publish(entry.hub, true);
          }
        }),
      subscribe: (personId) =>
        Stream.unwrap(
          Effect.gen(function* subscribeQueueChanges() {
            const entry = yield* Effect.acquireRelease(
              Effect.gen(function* acquireQueueSignals() {
                let existing = listeners.get(personId);
                if (!existing) {
                  existing = {
                    count: 0,
                    hub: yield* PubSub.sliding<boolean>(1),
                  };
                  listeners.set(personId, existing);
                }
                existing.count += 1;
                return existing;
              }),
              (current) =>
                Effect.gen(function* releaseQueueSignals() {
                  current.count -= 1;
                  if (current.count === 0) {
                    listeners.delete(personId);
                    yield* PubSub.shutdown(current.hub);
                  }
                })
            );
            const subscription = yield* PubSub.subscribe(entry.hub);
            return Stream.concat(
              Stream.succeed(true),
              Stream.fromSubscription(subscription)
            );
          })
        ),
    };
  });
}
