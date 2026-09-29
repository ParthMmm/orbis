import {
  normalizeSourceUrl,
  UnsupportedSourceUrlError,
} from "@orbis/contracts";
import type { SavedSet } from "@orbis/contracts";
import { OrbisApi } from "@orbis/contracts/http-api";
import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { Effect } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

/** The part of fetch this client uses, so a test can stand in for it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Preferences {
  readonly deviceToken: string;
  readonly serviceUrl: string;
}

export const SUPPORTED_LINK_HINT = "Use a YouTube or SoundCloud link.";

export const SAVE_TIMEOUT_MS = 5000;

export type SaveResult =
  | { readonly kind: "saved" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The canonical Source Link for a value, or null when Orbis cannot accept it. The rule is
 * the server's own, shared through @orbis/contracts, so both sides agree on what is saved.
 */
export const canonicalSourceUrl = (value: string): string | null => {
  try {
    return normalizeSourceUrl(value.trim()).url;
  } catch (error) {
    if (error instanceof UnsupportedSourceUrlError) {
      return null;
    }
    throw error;
  }
};

const LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;

/**
 * The first supported Source Link in a block of text, such as a clipboard holding a link
 * inside a sentence. Each candidate goes through the same canonical rule as the server.
 */
export const extractSourceUrl = (text: string): string | null => {
  for (const [match] of text.matchAll(LINK_PATTERN)) {
    const canonical = canonicalSourceUrl(
      match.replace(TRAILING_PUNCTUATION, "")
    );
    if (canonical) {
      return canonical;
    }
  }
  return null;
};

const baseUrl = (serviceUrl: string): string =>
  serviceUrl.trim().replace(/\/+$/u, "");

/**
 * Sends one Source Link to Orbis with the paired device token. The title is left out so the
 * server takes it from the source metadata. `url` must already be canonical.
 */
export const saveSourceUrl = async (
  url: string,
  options: {
    readonly fetch?: FetchLike;
    readonly preferences?: Preferences;
    readonly timeoutMs?: number;
  } = {}
): Promise<SaveResult> => {
  const preferences = options.preferences ?? getPreferenceValues<Preferences>();
  const send: FetchLike = options.fetch ?? fetch;
  const service = baseUrl(preferences.serviceUrl);
  if (!service.startsWith("https://")) {
    return {
      kind: "failed",
      message: "Set the Orbis Service URL to your https:// address.",
    };
  }
  let status: number | undefined;
  let timedOut = false;
  const fetchWithStatus = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      try {
        const response = await send(String(input), init ?? {});
        const { status: responseStatus } = response;
        status = responseStatus;
        return response;
      } catch (error) {
        timedOut = error instanceof Error && error.name === "TimeoutError";
        throw error;
      }
    },
    { preconnect: fetch.preconnect }
  );
  try {
    const saved: SavedSet = await Effect.runPromise(
      Effect.gen(function* save() {
        const client = yield* HttpApiClient.make(OrbisApi, {
          baseUrl: service,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader(
              "authorization",
              `Bearer ${preferences.deviceToken}`
            )
          ),
        });
        return yield* client.sets.save({ payload: { tags: [], url } });
      }).pipe(
        Effect.timeout(`${options.timeoutMs ?? SAVE_TIMEOUT_MS} millis`),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchWithStatus)
      )
    );
    return saved.id
      ? { kind: "saved" }
      : { kind: "failed", message: "Orbis returned a Set without an id." };
  } catch (error) {
    if (
      timedOut ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "TimeoutException"))
    ) {
      return {
        kind: "failed",
        message: "Orbis didn't answer in time. Try again.",
      };
    }
    if (status === undefined) {
      return { kind: "failed", message: `Couldn't reach Orbis at ${service}.` };
    }
    if (status === 409) {
      return { kind: "duplicate" };
    }
    if (status === 401 || status === 403) {
      return {
        kind: "failed",
        message: "Orbis rejected the device token. Pair this device again.",
      };
    }
    return { kind: "failed", message: `Orbis returned HTTP ${status}.` };
  }
};

export const startProgressToast = (): Promise<Toast> =>
  showToast({ style: Toast.Style.Animated, title: "Saving set…" });

/**
 * Finishes a capture command on the toast it already showed: a distinct rejection before
 * any request, or the outcome of the one save. The toast stays a single object so progress
 * turns into the result instead of being replaced.
 */
export const finishSave = async (
  toast: Toast,
  candidate: string | null
): Promise<void> => {
  if (candidate === null) {
    toast.style = Toast.Style.Failure;
    toast.title = "Unsupported link";
    toast.message = SUPPORTED_LINK_HINT;
    return;
  }
  const result = await saveSourceUrl(candidate);
  if (result.kind === "saved") {
    toast.style = Toast.Style.Success;
    toast.title = "Set saved";
    toast.message = candidate;
  } else if (result.kind === "duplicate") {
    toast.style = Toast.Style.Success;
    toast.title = "Already in your library";
    toast.message = candidate;
  } else {
    toast.style = Toast.Style.Failure;
    toast.title = "Couldn't save this set";
    toast.message = result.message;
  }
};
