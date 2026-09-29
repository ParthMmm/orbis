import { Context } from "effect";

export class LibraryPerson extends Context.Service<LibraryPerson, string>()(
  "@orbis/LibraryPerson"
) {}
