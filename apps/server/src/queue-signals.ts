import { Context, Effect, Layer, Option, PubSub, RcMap, Stream } from "effect";

/** Routes invalidations between request-scoped Queues belonging to the same Person. */
export class QueueSignals extends Context.Service<
  QueueSignals,
  {
    readonly publish: (personId: string) => Effect.Effect<void>;
    readonly subscribe: (personId: string) => Stream.Stream<boolean>;
  }
>()("@orbis/QueueSignals") {
  static readonly layer = Layer.effect(
    QueueSignals,
    Effect.gen(function* buildQueueSignals() {
      const hubs = yield* RcMap.make({
        lookup: (_personId: string) =>
          Effect.acquireRelease(PubSub.sliding<boolean>(1), PubSub.shutdown),
      });
      return QueueSignals.of({
        publish: Effect.fn("QueueSignals.publish")(function* publishQueueChange(
          personId: string
        ) {
          const hub = yield* RcMap.getOption(hubs, personId);
          if (Option.isSome(hub)) {
            yield* PubSub.publish(hub.value, true);
          }
        }, Effect.scoped),
        subscribe: (personId) =>
          Stream.unwrap(
            Effect.gen(function* subscribeQueueChanges() {
              const hub = yield* RcMap.get(hubs, personId);
              const subscription = yield* PubSub.subscribe(hub);
              return Stream.concat(
                Stream.succeed(true),
                Stream.fromSubscription(subscription)
              );
            })
          ),
      });
    })
  );
}
