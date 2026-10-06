import type { FeedNotice } from "./feed-signals.js";
import type { FeedIdentity, FeedOutcome } from "./feed-transport.js";

/** One open client socket as a runtime adapter exposes it. */
export interface FeedSocketPort {
  readonly identity: FeedIdentity;
  readonly send: (text: string) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface FeedSocketOperations {
  readonly deliver: (identity: FeedIdentity) => Promise<FeedOutcome>;
  readonly receive: (
    identity: FeedIdentity,
    text: string
  ) => Promise<FeedOutcome>;
  readonly closed: (connectionId: string) => Promise<void>;
  readonly subscribe: (listener: (notice: FeedNotice) => void) => () => void;
}

/**
 * Runs each socket's work in order and folds repeated wakes into one pending
 * delivery. Nothing here is durable: after eviction a new instance starts with
 * empty queues and reads each socket's position from storage.
 */
export const makeFeedSockets = (
  operations: FeedSocketOperations,
  sockets: () => readonly FeedSocketPort[]
) => {
  const tails = new Map<string, Promise<void>>();
  const waiting = new Set<string>();

  const apply = (port: FeedSocketPort, outcome: FeedOutcome) => {
    for (const message of outcome.send) {
      port.send(JSON.stringify(message));
    }
    if (outcome.close) {
      port.close(outcome.close.code, outcome.close.reason);
    }
  };

  const run = (port: FeedSocketPort, task: () => Promise<FeedOutcome>) => {
    const id = port.identity.connectionId;
    const next = (tails.get(id) ?? Promise.resolve())
      .then(async () => apply(port, await task()))
      .catch(() => port.close(1011, "Feed unavailable"));
    tails.set(id, next);
    void next.finally(() => {
      if (tails.get(id) === next) {
        tails.delete(id);
      }
    });
    return next;
  };

  const deliver = (port: FeedSocketPort) => {
    const id = port.identity.connectionId;
    if (waiting.has(id)) {
      return;
    }
    waiting.add(id);
    void run(port, () => {
      waiting.delete(id);
      return operations.deliver(port.identity);
    });
  };

  const notice = (event: FeedNotice) => {
    for (const port of sockets()) {
      if (
        event.kind === "changed"
          ? port.identity.personId === event.personId
          : port.identity.keyId === event.keyId
      ) {
        deliver(port);
      }
    }
  };

  return {
    closed: (port: FeedSocketPort) =>
      operations.closed(port.identity.connectionId),
    receive: (port: FeedSocketPort, text: string) =>
      run(port, () => operations.receive(port.identity, text)),
    start: () => operations.subscribe(notice),
  };
};
