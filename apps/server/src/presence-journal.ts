import { Context, Effect, Layer } from "effect";

import type { DatabaseClient } from "./db/service.js";

export interface PresenceTransition {
  readonly personId: string;
  readonly cause:
    | "play"
    | "pause"
    | "stop"
    | "renew"
    | "supersede"
    | "expiry"
    | "legacy-report"
    | "legacy-expiry"
    | "queue"
    | "revocation"
    | "removal";
  /** The Person's visible Set before and after the committing transaction. */
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Receives every change to a Person's visible Presence inside the transaction that commits it.
 * The change feed (#210) replaces the default layer, which records nothing.
 */
export class PresenceJournal extends Context.Service<
  PresenceJournal,
  {
    readonly record: (
      tx: DatabaseClient,
      transition: PresenceTransition
    ) => Effect.Effect<void, unknown>;
  }
>()("@orbis/PresenceJournal") {
  static readonly unrecorded = Layer.succeed(PresenceJournal, {
    record: () => Effect.void,
  });
}
