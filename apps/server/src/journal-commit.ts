import { Context } from "effect";

/** The notices of one outermost journal transaction, published once it commits. */
export class JournalCommit extends Context.Service<
  JournalCommit,
  { readonly changed: Set<string>; readonly revoked: Set<string> }
>()("@orbis/JournalCommit") {}
