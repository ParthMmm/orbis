import { Effect } from "effect";

import { LibraryError } from "./errors.js";

type RedirectFetch = (url: string, signal: AbortSignal) => Promise<Response>;

/**
 * The SoundCloud app shares `on.soundcloud.com` links, which name no track until SoundCloud
 * redirects them. Only these hosts are asked, so any other link costs no request.
 */
const SHORT_LINK_HOSTS = new Set(["on.soundcloud.com"]);

const SHORT_LINK_TIMEOUT = "5 seconds";

const unresolved = () =>
  new LibraryError({
    message: "Could not open this SoundCloud short link.",
    statusCode: 400,
  });

const defaultFetch: RedirectFetch = (url, signal) =>
  fetch(url, { redirect: "manual", signal });

const isShortLink = (value: string) => {
  try {
    return SHORT_LINK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * The address a short link redirects to, or the value unchanged when it is not a short link.
 * The result still goes through the Source Link rule, so a redirect elsewhere is refused there.
 */
export const expandShortLink = (
  value: string,
  request: RedirectFetch = defaultFetch
): Effect.Effect<string, LibraryError> => {
  if (!isShortLink(value.trim())) {
    return Effect.succeed(value);
  }
  return Effect.gen(function* expandShortLinkEffect() {
    const response = yield* Effect.tryPromise({
      catch: unresolved,
      try: (signal) => request(value.trim(), signal),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return yield* Effect.fail(unresolved());
    }
    return new URL(location, value.trim()).toString();
  }).pipe(
    Effect.timeoutOrElse({
      duration: SHORT_LINK_TIMEOUT,
      orElse: () => Effect.fail(unresolved()),
    })
  );
};
