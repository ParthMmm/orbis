import { callOrbis } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/** Playback Position bounds the API accepts, in seconds (one week). */
const MAX_POSITION = 604_800;

export const playSet = (credentials: Credentials, setId: string) =>
  callOrbis(credentials, (client) => client.queue.play({ payload: { setId } }));

/** Replaces the queue with the Playlist's Sets that have kept audio, in order. */
export const replaceQueueWithPlaylist = (
  credentials: Credentials,
  playlistId: string
) =>
  callOrbis(credentials, (client) =>
    client.queue.replaceWithPlaylist({ payload: { playlistId } })
  );

export const queueSet = (
  credentials: Credentials,
  setId: string,
  placement: "next" | "end"
) =>
  callOrbis(credentials, (client) =>
    client.queue.insert({ payload: { placement, setId } })
  );

export const completeSet = (credentials: Credentials, setId: string) =>
  callOrbis(credentials, (client) =>
    client.queue.complete({ payload: { setId } })
  );

export const reportPosition = (
  credentials: Credentials,
  setId: string,
  seconds: number
) =>
  callOrbis(credentials, (client) =>
    client.library.setPosition({
      params: { id: setId },
      payload: { seconds: Math.max(0, Math.min(MAX_POSITION, seconds)) },
    })
  );

/**
 * A stream grant's audio URL on the API. An `<audio>` element cannot send the key,
 * so the API signs one Set's audio route for a day (ADR 0007); the page accepts
 * only a grant for exactly that route.
 */
export const streamUrl = async (
  credentials: Credentials,
  setId: string
): Promise<ApiResult<string>> => {
  const grant = await callOrbis(credentials, (client) =>
    client.sets.audioGrant({ params: { id: setId } })
  );
  if (!grant.ok) {
    return grant;
  }
  const granted = new URL(grant.value.url, "http://grant.invalid");
  if (
    granted.origin !== "http://grant.invalid" ||
    granted.pathname !== `/sets/${encodeURIComponent(setId)}/audio`
  ) {
    return { failure: "failed", ok: false, status: undefined };
  }
  return {
    ok: true,
    value: `${credentials.apiUrl}${granted.pathname}${granted.search}`,
  };
};
