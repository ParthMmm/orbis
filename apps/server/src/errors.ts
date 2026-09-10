import { Schema } from "effect";

// TaggedError is a curried schema factory, not an Error constructor.
const { TaggedError: taggedFailure } = Schema;

export class LibraryError extends taggedFailure<LibraryError>()(
  "LibraryError",
  {
    message: Schema.String,
    statusCode: Schema.Number,
  }
) {}
