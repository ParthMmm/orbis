import { useNavigate, useRouter } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { readLiveEvents } from "@/lib/events";
import type { ChangeTopic, ListeningQueue, Presence } from "@/lib/events";
import type { Credentials } from "@/lib/orbis";
import { forgetKey } from "@/lib/stored-key";

const RECONNECT_MS = 1000;
// One reload covers a burst of `changed` frames, such as a Playlist reorder.
const COALESCE_MS = 250;

/** The routes whose loaders read each topic's HTTP routes. */
const TOPIC_ROUTES: Record<ChangeTopic, readonly string[]> = {
  library: [
    "/_app/",
    "/_app/people/$id",
    "/_app/playlists/$id",
    "/_app/sets/$id",
  ],
  "listen-history": ["/_app/people/$id"],
  playlist: [
    "/_app/",
    "/_app/people/$id",
    "/_app/playlists/",
    "/_app/playlists/$id",
  ],
  set: ["/_app/", "/_app/people/$id", "/_app/playlists/$id", "/_app/sets/$id"],
};

export interface LiveEvents {
  /** The Person's Listening Queue, or null until the stream sends it. */
  readonly queue: ListeningQueue | null;
  /** What visible People are listening to now (ADR 0009). */
  readonly presence: Presence;
  /** True while the stream is down and the page retries every second. */
  readonly reconnecting: boolean;
}

const LiveEventsContext = createContext<LiveEvents>({
  presence: [],
  queue: null,
  reconnecting: false,
});

/**
 * One `/events` stream for every signed-in page. A `changed` frame reloads the
 * routes that read its topic. The stream reconnects a second after it drops,
 * reloads every route because it may have missed frames, and signs out when the
 * API refuses the key.
 */
export const LiveEventsProvider = ({
  children,
  credentials: { apiUrl, key },
}: {
  readonly children: ReactNode;
  readonly credentials: Credentials;
}) => {
  const navigate = useNavigate();
  const router = useRouter();
  const [queue, setQueue] = useState<ListeningQueue | null>(null);
  const [presence, setPresence] = useState<Presence>([]);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let dropped = false;
    const changed = new Set<ChangeTopic>();
    const reload = () => {
      reloadTimer = undefined;
      const routes = new Set(
        [...changed].flatMap((topic) => TOPIC_ROUTES[topic])
      );
      changed.clear();
      void router.invalidate({ filter: (match) => routes.has(match.routeId) });
    };
    const connect = async () => {
      const closed = await readLiveEvents(
        { apiUrl, key },
        {
          onChanged: (topic) => {
            changed.add(topic);
            reloadTimer ??= setTimeout(reload, COALESCE_MS);
          },
          onOpen: () => {
            if (dropped) {
              dropped = false;
              void router.invalidate();
            }
          },
          onPresence: (current) => {
            setPresence(current);
            setReconnecting(false);
          },
          onQueue: (current) => {
            setQueue(current);
            setReconnecting(false);
          },
        },
        controller.signal
      );
      if (controller.signal.aborted) {
        return;
      }
      if (!closed.ok && closed.failure === "rejected") {
        forgetKey();
        await navigate({ search: { notice: "expired" }, to: "/sign-in" });
        return;
      }
      // The reload on reconnect covers pending changes; reloading now would fail.
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
      changed.clear();
      dropped = true;
      setReconnecting(true);
      timer = setTimeout(connect, RECONNECT_MS);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(reloadTimer);
    };
  }, [apiUrl, key, navigate, router]);
  return (
    <LiveEventsContext value={{ presence, queue, reconnecting }}>
      {children}
    </LiveEventsContext>
  );
};

export const useLiveEvents = (): LiveEvents => use(LiveEventsContext);
