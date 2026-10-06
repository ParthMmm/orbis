import { Context, Effect, Layer } from "effect";

export type FeedNotice =
  | { readonly kind: "changed"; readonly personId: string }
  | { readonly kind: "revoked"; readonly keyId: string };

type Listener = (notice: FeedNotice) => void;

/** Wakes feed readers after a commit. A notice says only that a Person's journal may have moved. */
export class FeedSignals extends Context.Service<
  FeedSignals,
  {
    readonly publish: (notices: readonly FeedNotice[]) => Effect.Effect<void>;
    readonly subscribe: (listener: Listener) => () => void;
  }
>()("@orbis/FeedSignals") {
  static make(): typeof FeedSignals.Service {
    const listeners = new Set<Listener>();
    return {
      publish: (notices) =>
        Effect.gen(function* notifyListeners() {
          for (const notice of notices) {
            for (const listener of listeners) {
              // A failing transport must not fail the mutation that already committed.
              yield* Effect.try({
                catch: String,
                try: () => listener(notice),
              }).pipe(
                Effect.tapError((reason) =>
                  Effect.logWarning("feed listener failed").pipe(
                    Effect.annotateLogs({ reason })
                  )
                ),
                Effect.ignore
              );
            }
          }
        }),
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
