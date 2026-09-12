import {
  normalizeSourceUrl as normalizeCanonicalSourceUrl,
  UnsupportedSourceUrlError,
} from "@orbis/contracts";

import { LibraryError } from "./errors.js";

export { youTubeVideoId } from "@orbis/contracts";

/**
 * The canonical rule lives in @orbis/contracts so every client shares it. The library
 * reports a rejection as a LibraryError, which is what the HTTP layer already maps to 400.
 */
export const normalizeSourceUrl = (value: string) => {
  try {
    return normalizeCanonicalSourceUrl(value);
  } catch (error) {
    if (error instanceof UnsupportedSourceUrlError) {
      throw new LibraryError({
        message: error.message,
        statusCode: error.statusCode,
      });
    }
    throw error;
  }
};
