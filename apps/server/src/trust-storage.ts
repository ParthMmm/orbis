import { setTimeout } from "node:timers/promises";

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

export const retryTrustOperation = async <T>(
  action: () => T,
  deadline = Date.now() + 5000
): Promise<T> => {
  try {
    return action();
  } catch (error) {
    if (
      !(error instanceof Error && isTrustBusy(error)) ||
      Date.now() >= deadline
    ) {
      throw error;
    }
    await setTimeout(10);
    return retryTrustOperation(action, deadline);
  }
};
