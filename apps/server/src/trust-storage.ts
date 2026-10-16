import { Effect, Schedule, Schema } from "effect";

import type { decodeTrust, TrustStore } from "./identity.js";

export interface TrustStorage {
  readonly initialize: (input: {
    readonly target: string;
    readonly legacyPath?: string | undefined;
    readonly decode: typeof decodeTrust;
    readonly empty: () => TrustStore;
  }) => void;
  readonly read: (target: string, decode: typeof decodeTrust) => TrustStore;
  readonly mutate: <T>(
    target: string,
    decode: typeof decodeTrust,
    change: (store: TrustStore) => {
      readonly store?: TrustStore;
      readonly value: T;
    }
  ) => T;
}

let storage: TrustStorage | undefined;

export const configureTrustStorage = (adapter: TrustStorage): void => {
  storage = adapter;
};

export const trustStorage = (): TrustStorage => {
  if (!storage) {
    throw new Error("Trust storage has not been configured.");
  }
  return storage;
};

export const isTrustBusy = (error: Error): boolean =>
  "code" in error && error.code === "SQLITE_BUSY";

// TaggedError is a curried schema factory, not an Error constructor.
const { TaggedError: taggedFailure } = Schema;

export class TrustStoreFailure extends taggedFailure<TrustStoreFailure>()(
  "TrustStoreFailure",
  { cause: Schema.Defect() }
) {}

const isBusyFailure = (failure: TrustStoreFailure) =>
  failure.cause instanceof Error && isTrustBusy(failure.cause);

export const trustOperation = <T>(action: () => T) =>
  Effect.try({
    catch: (cause) => new TrustStoreFailure({ cause }),
    try: action,
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("10 millis").pipe(
        Schedule.upTo({ duration: "5 seconds" })
      ),
      while: isBusyFailure,
    })
  );
