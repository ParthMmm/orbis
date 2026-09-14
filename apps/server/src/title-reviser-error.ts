import { Schema } from "effect";

// TaggedError is a curried schema factory, not an Error constructor.
const { TaggedError: taggedFailure } = Schema;

export const TitleReviserReason = Schema.Literals([
  "not-configured",
  "model-unavailable",
  "unexpected-response",
]);

export class TitleReviserError extends taggedFailure<TitleReviserError>()(
  "TitleReviserError",
  {
    message: Schema.String,
    reason: TitleReviserReason,
  }
) {}
