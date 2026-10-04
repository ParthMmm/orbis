import type { CutoverMode } from "./cutover.js";
import { cutoverHandler } from "./cutover.js";
import type { LoggingOptions } from "./logging.js";
import { makeNodeAudioHandler } from "./node-audio-http.js";

export const makeNodeHandler = (options: {
  readonly audioDir: string;
  readonly streamSecret: Buffer;
  readonly mode: CutoverMode;
  readonly logging?: LoggingOptions;
}) => {
  const handler = cutoverHandler(
    makeNodeAudioHandler(options),
    options.mode,
    options
  );
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      url.pathname = url.pathname.slice(4) || "/";
      return handler(new Request(url, request), "device");
    }
    return handler(request, "device");
  };
};
