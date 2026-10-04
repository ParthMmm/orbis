import type { AudioState, SavedSet } from "@orbis/contracts";
import type { Effect } from "effect";
import { Context } from "effect";

import type { LibraryError } from "./errors.js";
import type { Library } from "./library.js";

export interface AudioFile {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: number;
}
export class Audio extends Context.Service<
  Audio,
  {
    readonly isConfigured: boolean;
    readonly requestDownload: (
      id: string
    ) => Effect.Effect<
      { set: SavedSet; accepted: boolean },
      LibraryError,
      Library
    >;
    readonly audioState: (
      id: string
    ) => Effect.Effect<AudioState, LibraryError, Library>;
    readonly audioFile: (
      id: string
    ) => Effect.Effect<AudioFile, LibraryError, Library>;
    readonly cancelDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError, Library>;
    readonly processNext: () => Effect.Effect<boolean, never>;
  }
>()("@orbis/Audio") {}
