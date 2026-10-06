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
  readonly visibleSetBefore: string | null;
  readonly visibleSetAfter: string | null;
}

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
