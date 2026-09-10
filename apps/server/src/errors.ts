import { Schema } from "effect";

export class LibraryError extends Schema.TaggedError<LibraryError>()(
	"LibraryError",
	{
		message: Schema.String,
		statusCode: Schema.Number,
	}
) {}
