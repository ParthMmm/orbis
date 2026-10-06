import type { FeedNotice } from "./feed-signals.js";
import type { FeedIdentity, FeedOutcome } from "./feed-transport.js";

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

const apply = (port: FeedSocketPort, outcome: FeedOutcome) => {
  for (const message of outcome.send) {
    port.send(JSON.stringify(message));
  }
  if (outcome.close) {
    port.close(outcome.close.code, outcome.close.reason);
  }
};

export const makeFeedSockets = (
  operations: FeedSocketOperations,
  sockets: () => readonly FeedSocketPort[]
) => {
  const queueBySocket = new Map<string, Promise<void>>();
  const deliveryPending = new Set<string>();

  const run = (port: FeedSocketPort, task: () => Promise<FeedOutcome>) => {
    const id = port.identity.connectionId;
    const previous = queueBySocket.get(id);
    const next = (async () => {
      await previous;
      try {
        apply(port, await task());
      } catch {
        port.close(1011, "Feed unavailable");
      }
    })();
    queueBySocket.set(id, next);
    void (async () => {
      await next;
      if (queueBySocket.get(id) === next) {
        queueBySocket.delete(id);
      }
    })();
    return next;
  };

  const deliver = (port: FeedSocketPort) => {
    const id = port.identity.connectionId;
    if (deliveryPending.has(id)) {
      return;
    }
    deliveryPending.add(id);
    void run(port, () => {
      deliveryPending.delete(id);
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
