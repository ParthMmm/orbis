import { Schema } from "effect";

const VersosReason = Schema.Literals([
  "not-configured",
  "unavailable",
  "rejected",
  "unexpected-response",
]);
const { TaggedError: taggedFailure } = Schema;
export class VersosError extends taggedFailure<VersosError>()("VersosError", {
  reason: VersosReason,
}) {}
