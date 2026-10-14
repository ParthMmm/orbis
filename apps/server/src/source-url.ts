import {
  normalizeSourceUrl as normalizeCanonicalSourceUrl,
  UnsupportedSourceUrlError,
} from "@orbis/contracts";

import { LibraryError } from "./errors.js";

export { youTubeVideoId } from "@orbis/contracts";

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
