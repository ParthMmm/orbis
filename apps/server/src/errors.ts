import { Effect, Predicate, Schema } from "effect";

// TaggedError is a curried schema factory, not an Error constructor.
const { TaggedError: taggedFailure } = Schema;

export class LibraryError extends taggedFailure<LibraryError>()(
  "LibraryError",
  {
    message: Schema.String,
    statusCode: Schema.Number,
  }
) {}

const tagOf = <E>(failure: E) =>
  Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag)
    ? failure._tag
    : "unknown";

/** Logged by tag only: a query error's message carries the query's parameters. */
export const logUnexpectedFailure = <E>(failure: E) =>
  failure instanceof LibraryError
    ? Effect.void
    : Effect.logError("unexpected failure").pipe(
        Effect.annotateLogs({ errorTag: tagOf(failure) })
      );

/** Keeps a LibraryError; logs any other failure and replaces it with a 500 carrying `message`. */
export const asLibraryError =
  (message: string) =>
  <A, E, R>(
    operation: Effect.Effect<A, E, R>
  ): Effect.Effect<A, LibraryError, R> =>
    operation.pipe(
      Effect.tapError(logUnexpectedFailure),
      Effect.mapError((failure) =>
        failure instanceof LibraryError
          ? failure
          : new LibraryError({ message, statusCode: 500 })
      )
    );
