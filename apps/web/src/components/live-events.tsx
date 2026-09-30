import { useNavigate } from "@tanstack/react-router";
import { createContext, use, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { readLiveEvents } from "@/lib/events";
import type { ListeningQueue, Presence } from "@/lib/events";
import type { Credentials } from "@/lib/orbis";
import { forgetKey } from "@/lib/stored-key";

const RECONNECT_MS = 1000;

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
 * One `/events` stream for every signed-in page. It reconnects a second after the
 * stream drops, and signs out when the API refuses the key.
 */
export const LiveEventsProvider = ({
  children,
  credentials: { apiUrl, key },
}: {
  readonly children: ReactNode;
  readonly credentials: Credentials;
}) => {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<ListeningQueue | null>(null);
  const [presence, setPresence] = useState<Presence>([]);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const closed = await readLiveEvents(
        { apiUrl, key },
        {
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
      setReconnecting(true);
      timer = setTimeout(connect, RECONNECT_MS);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiUrl, key, navigate]);
  return (
    <LiveEventsContext value={{ presence, queue, reconnecting }}>
      {children}
    </LiveEventsContext>
  );
};

export const useLiveEvents = (): LiveEvents => use(LiveEventsContext);
