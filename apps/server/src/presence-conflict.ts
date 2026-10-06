import { Schema } from "effect";

const { TaggedError: taggedFailure } = Schema;

export class PresenceConflict extends taggedFailure<PresenceConflict>()(
  "PresenceConflict",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "stale",
      "queue-changed",
      "action-reused",
      "session-set",
      "session-limit",
    ]),
  }
) {}
export type ConflictReason = PresenceConflict["reason"];

const CONFLICTS: Record<ConflictReason, string> = {
  "action-reused": "This action ID was already used with different input.",
  "queue-changed":
    "The active Queue Set changed. Re-read the Queue before reporting playback.",
  "session-limit":
    "This key holds too many sessions. Reuse one or rotate the key.",
  "session-set": "A session is bound to the Set it started with.",
  stale: "A newer action or another device owns this Presence.",
};
export const conflict = (reason: ConflictReason) =>
  new PresenceConflict({ message: CONFLICTS[reason], reason });
