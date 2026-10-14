import {
  normalizeSourceUrl,
  UnsupportedSourceUrlError,
} from "@orbis/contracts";
import { OrbisApi } from "@orbis/contracts/http-api";
import {
  getPreferenceValues,
  LocalStorage,
  showToast,
  Toast,
} from "@raycast/api";
import { Effect, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

/** The part of fetch this client uses, so a test can stand in for it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Preferences {
  readonly deviceToken?: string;
  readonly serviceUrl: string;
}

export const SUPPORTED_LINK_HINT = "Use a YouTube or SoundCloud link.";

export const REQUEST_TIMEOUT_MS = 5000;

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

/** A declared error body, such as a 400 that names what the server refused. */
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.String })
);

const baseUrl = (serviceUrl: string): string =>
  serviceUrl.trim().replace(/\/+$/u, "");

/** Where Sign In keeps the key it redeemed. Raycast encrypts this storage. */
const DEVICE_TOKEN_KEY = "deviceToken";

export const SIGN_IN_HINT = "Run Sign In to Orbis with a Sign-in Code.";

/**
 * The key from Sign In, or else the Device Token preference, so a setup from before Sign
 * In keeps working. Null when neither is set.
 */
const readDeviceToken = async (
  preferences: Preferences
): Promise<string | null> =>
  (await LocalStorage.getItem<string>(DEVICE_TOKEN_KEY)) ??
  (preferences.deviceToken?.trim() || null);

const makeClient = (service: string, token: string | null) =>
  HttpApiClient.make(OrbisApi, {
    baseUrl: service,
    transformClient:
      token === null
        ? (client) => client
        : HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`)
          ),
  });

type OrbisClient = Effect.Success<ReturnType<typeof makeClient>>;

interface CallOptions {
  readonly fetch?: FetchLike;
  readonly preferences?: Preferences;
  readonly timeoutMs?: number;
}

type Reply<A> =
  | { readonly kind: "ok"; readonly value: A }
  | {
      readonly kind: "answered";
      readonly message: string | undefined;
      readonly status: number;
    }
  | { readonly kind: "failed"; readonly message: string };

const callOrbis = async <A, E>(
  token: string | null,
  run: (client: OrbisClient) => Effect.Effect<A, E>,
  options: CallOptions
): Promise<Reply<A>> => {
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
    const value = await Effect.runPromise(
      makeClient(service, token).pipe(
        Effect.flatMap(run),
        Effect.timeout(`${options.timeoutMs ?? REQUEST_TIMEOUT_MS} millis`),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchWithStatus)
      )
    );
    return { kind: "ok", value };
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
    return {
      kind: "answered",
      message: Option.getOrUndefined(
        error instanceof Error ? Option.none() : decodeErrorBody(error)
      )?.message,
      status,
    };
  }
};

/**
 * Sends one Source Link to Orbis with this device's key. The title is left out so the
 * server takes it from the source metadata. `url` must already be canonical.
 */
export const saveSourceUrl = async (
  url: string,
  options: CallOptions = {}
): Promise<SaveResult> => {
  const preferences = options.preferences ?? getPreferenceValues<Preferences>();
  const token = await readDeviceToken(preferences);
  if (token === null) {
    return { kind: "failed", message: SIGN_IN_HINT };
  }
  const reply = await callOrbis(
    token,
    (client) => client.sets.save({ payload: { tags: [], url } }),
    { ...options, preferences }
  );
  if (reply.kind === "ok") {
    return { kind: "saved" };
  }
  if (reply.kind === "failed") {
    return reply;
  }
  // A 201 means the Set is saved, even when this build cannot decode a newer response.
  if (reply.status === 201) {
    return { kind: "saved" };
  }
  if (reply.status === 409) {
    return { kind: "duplicate" };
  }
  if (reply.status === 401 || reply.status === 403) {
    return {
      kind: "failed",
      message: `Orbis rejected the device token. ${SIGN_IN_HINT}`,
    };
  }
  return {
    kind: "failed",
    message: reply.message ?? `Orbis returned HTTP ${reply.status}.`,
  };
};

export type SignInResult =
  | { readonly kind: "signedIn"; readonly username: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Redeems a Sign-in Code for a key labeled "Raycast" and keeps the key for later saves.
 * The server normalizes the code's case and separators. Nothing is stored unless the
 * response decodes, so a failed sign-in leaves the previous key in place.
 */
export const signIn = async (
  code: string,
  options: CallOptions = {}
): Promise<SignInResult> => {
  const presented = code.trim();
  if (!presented) {
    return {
      kind: "failed",
      message: "Type the Sign-in Code from Orbis Settings.",
    };
  }
  const reply = await callOrbis(
    null,
    (client) =>
      client.signIn.redeem({ payload: { code: presented, label: "Raycast" } }),
    options
  );
  if (reply.kind === "failed") {
    return reply;
  }
  if (reply.kind === "answered") {
    return {
      kind: "failed",
      message: reply.message ?? `Orbis returned HTTP ${reply.status}.`,
    };
  }
  await LocalStorage.setItem(DEVICE_TOKEN_KEY, reply.value.key);
  return { kind: "signedIn", username: reply.value.person.username };
};

export const startToast = (title: string): Promise<Toast> =>
  showToast({ style: Toast.Style.Animated, title });

export const startProgressToast = (): Promise<Toast> =>
  startToast("Saving set…");

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
