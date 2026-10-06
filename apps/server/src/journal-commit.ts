import { Context } from "effect";

export class JournalCommit extends Context.Service<
  JournalCommit,
  { readonly changed: Set<string>; readonly revoked: Set<string> }
>()("@orbis/JournalCommit") {}
