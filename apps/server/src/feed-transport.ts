import { createHash } from "node:crypto";

import type { FeedServerMessage } from "@orbis/contracts";
import {
  FEED_ACK_WINDOW,
  FEED_PROTOCOL,
  FEED_TICKET_PROTOCOL_PREFIX,
  FeedClientMessageSchema,
  FeedCloseCode,
} from "@orbis/contracts/http-api";
import { eq, lte, notInArray } from "drizzle-orm";
import { Effect, Queue, Schema, Stream } from "effect";

import { feedConnections, feedTickets } from "./db/schema.js";
import type { DatabaseClient } from "./db/service.js";
import { LibraryError } from "./errors.js";
import type { FeedNotice } from "./feed-signals.js";
import { cursorSequence } from "./feed.js";
import type { CatchUp, makeFeed } from "./feed.js";

export const TICKET_TTL_MS = 30_000;
const HEARTBEAT = "30 seconds";

/** What a client socket's serialized attachment holds. Feed state stays in storage. */
export interface FeedIdentity {
  readonly connectionId: string;
  readonly keyId: string;
  readonly personId: string;
}

export interface FeedClose {
  readonly code: number;
  readonly reason: string;
}

/** Frames to send in order, then an optional close. */
export interface FeedOutcome {
  readonly send: readonly FeedServerMessage[];
  readonly close?: FeedClose;
}

export type UpgradeDecision =
  | { readonly kind: "accepted"; readonly identity: FeedIdentity }
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly message: string;
    };

const rejected = (status: number, message: string): UpgradeDecision => ({
  kind: "rejected",
  message,
  status,
});

const accepted = (identity: FeedIdentity): UpgradeDecision => ({
  identity,
  kind: "accepted",
});

const INVALID_TICKET = rejected(401, "Request a new feed ticket.");
const ENDED: FeedClose = {
  code: FeedCloseCode.closed,
  reason: "Feed access ended",
};

const protocolClose = (reason: string): FeedOutcome => ({
  close: { code: FeedCloseCode.protocol, reason },
  send: [],
});

const digest = (ticket: string) =>
  createHash("sha256").update(ticket, "utf-8").digest("hex");

/** The frames for one catch-up, and the cursor the client holds after applying them. */
export interface FeedFrames {
  readonly messages: readonly FeedServerMessage[];
  readonly cursor: string | null;
}

/** Turns one catch-up into the frames a client receives. */
export const feedMessages = (result: CatchUp, initial: boolean): FeedFrames => {
  switch (result.kind) {
    case "closed": {
      return { cursor: null, messages: [] };
    }
    case "snapshot": {
      const { cursor, presence, queue } = result.snapshot;
      return {
        cursor,
        messages: [
          ...(result.reset === null
            ? []
            : [{ kind: "reset" as const, reason: result.reset }]),
          { cursor, kind: "snapshot", presence, queue },
          { cursor, kind: "ready" },
        ],
      };
    }
    default: {
      const { cursor, deliveries } = result;
      return {
        cursor,
        messages: [
          ...(deliveries.length === 0
            ? []
            : [{ cursor, deliveries, kind: "changes" as const }]),
          ...(initial ? [{ cursor, kind: "ready" as const }] : []),
        ],
      };
    }
  }
};

const offeredTicket = (header: string | null) => {
  const offered = (header ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const tickets = offered.filter((token) =>
    token.startsWith(FEED_TICKET_PROTOCOL_PREFIX)
  );
  return {
    protocol: offered.includes(FEED_PROTOCOL),
    ticket:
      tickets.length === 1
        ? (tickets[0]?.slice(FEED_TICKET_PROTOCOL_PREFIX.length) ?? "")
        : "",
  };
};

const transportFailure = () =>
  new LibraryError({ message: "The feed is unavailable.", statusCode: 500 });

export const makeFeedTransport = (input: {
  readonly db: DatabaseClient;
  readonly reader: ReturnType<typeof makeFeed>;
  readonly subscribe: (listener: (notice: FeedNotice) => void) => () => void;
}) => {
  const { db, reader } = input;

  const mintTicket = (keyId: string) =>
    Effect.gen(function* mint() {
      const access = yield* reader.authorize(keyId);
      if (access === null) {
        return yield* new LibraryError({
          message: "Sign in with a device key.",
          statusCode: 403,
        });
      }
      const ticket = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).toString("base64url");
      const now = Date.now();
      const expiresAt = now + TICKET_TTL_MS;
      yield* db.transaction((tx) =>
        Effect.gen(function* storeTicket() {
          yield* tx.delete(feedTickets).where(lte(feedTickets.expiresAt, now));
          yield* tx.insert(feedTickets).values({
            authorizationEpoch: access.authorizationEpoch,
            digest: digest(ticket),
            expiresAt,
            keyId,
            personId: access.personId,
            protocol: FEED_PROTOCOL,
          });
        })
      );
      return {
        expiresAt: new Date(expiresAt).toISOString(),
        protocol: FEED_PROTOCOL,
        ticket,
      };
    }).pipe(
      Effect.mapError((failure) =>
        failure instanceof LibraryError ? failure : transportFailure()
      )
    );

  /**
   * Checks an upgrade and spends its ticket. Origin is checked first, so a
   * refused browser page cannot burn a ticket it saw. A ticket is deleted
   * before its checks run, so every outcome after lookup spends it.
   */
  const accept = (request: {
    readonly url: string;
    readonly method: string;
    readonly header: (name: string) => string | null;
    readonly allowedOrigins: readonly string[];
  }) =>
    Effect.gen(function* acceptUpgrade() {
      const url = new URL(request.url);
      if (url.search !== "") {
        return rejected(400, "The feed socket takes no URL parameters.");
      }
      const origin = request.header("origin");
      if (
        origin !== null &&
        origin !== url.origin &&
        !request.allowedOrigins.includes(origin)
      ) {
        return rejected(403, "This browser Origin is not allowed.");
      }
      if (
        request.method !== "GET" ||
        request.header("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return rejected(426, "Upgrade to a WebSocket.");
      }
      const offered = offeredTicket(request.header("sec-websocket-protocol"));
      if (!offered.protocol) {
        return rejected(400, `Offer the ${FEED_PROTOCOL} protocol.`);
      }
      if (offered.ticket === "") {
        return INVALID_TICKET;
      }
      return yield* db.transaction((tx) =>
        Effect.gen(function* spendTicket() {
          const [ticket] = yield* tx
            .delete(feedTickets)
            .where(eq(feedTickets.digest, digest(offered.ticket)))
            .returning();
          const now = Date.now();
          if (
            !ticket ||
            ticket.expiresAt <= now ||
            ticket.protocol !== FEED_PROTOCOL
          ) {
            return INVALID_TICKET;
          }
          const access = yield* reader.authorize(ticket.keyId);
          if (
            access === null ||
            access.personId !== ticket.personId ||
            access.authorizationEpoch !== ticket.authorizationEpoch
          ) {
            return INVALID_TICKET;
          }
          const identity: FeedIdentity = {
            connectionId: crypto.randomUUID(),
            keyId: ticket.keyId,
            personId: ticket.personId,
          };
          yield* tx.insert(feedConnections).values({
            id: identity.connectionId,
            keyId: identity.keyId,
            openedAt: now,
            personId: identity.personId,
          });
          return accepted(identity);
        })
      );
    }).pipe(Effect.mapError(transportFailure));

  const connection = (id: string) =>
    db
      .select()
      .from(feedConnections)
      .where(eq(feedConnections.id, id))
      .limit(1)
      .pipe(Effect.map(([row]) => row));

  const forget = (id: string) =>
    db.delete(feedConnections).where(eq(feedConnections.id, id));

  const ended = (identity: FeedIdentity, ackedCursor: string | null) =>
    forget(identity.connectionId).pipe(
      Effect.as<FeedOutcome>({
        close: ENDED,
        send: [{ cursor: ackedCursor, kind: "closing", reason: "revoked" }],
      })
    );

  /** Sends what the client has not seen. Every call rechecks the key and each row's access. */
  const deliver = (identity: FeedIdentity) =>
    Effect.gen(function* deliverChanges() {
      const row = yield* connection(identity.connectionId);
      if (!row) {
        return { close: ENDED, send: [] } satisfies FeedOutcome;
      }
      if (!row.greeted) {
        return (yield* reader.authorize(identity.keyId)) === null
          ? yield* ended(identity, null)
          : ({ send: [] } satisfies FeedOutcome);
      }
      const result = yield* reader.catchUp({
        cursor: row.sentCursor,
        keyId: identity.keyId,
      });
      if (result.kind === "closed") {
        return yield* ended(identity, row.ackedCursor);
      }
      const { cursor, messages } = feedMessages(result, false);
      if (messages.length > 0 && row.pending.length >= FEED_ACK_WINDOW) {
        yield* forget(identity.connectionId);
        return {
          close: { code: FeedCloseCode.slow, reason: "Acknowledge sooner" },
          send: [{ cursor: row.ackedCursor, kind: "closing", reason: "slow" }],
        } satisfies FeedOutcome;
      }
      const sequence = cursor === null ? null : cursorSequence(cursor);
      yield* db
        .update(feedConnections)
        .set({
          pending:
            messages.length === 0 || sequence === null
              ? row.pending
              : [...row.pending, sequence],
          sentCursor: cursor,
        })
        .where(eq(feedConnections.id, identity.connectionId));
      return { send: messages } satisfies FeedOutcome;
    }).pipe(Effect.mapError(transportFailure));

  const receive = (identity: FeedIdentity, text: string) =>
    Effect.gen(function* receiveMessage() {
      const message = yield* Effect.try(() =>
        Schema.decodeUnknownSync(FeedClientMessageSchema)(JSON.parse(text))
      ).pipe(Effect.option);
      if (message._tag === "None") {
        return protocolClose("Invalid feed message");
      }
      const row = yield* connection(identity.connectionId);
      if (!row) {
        return { close: ENDED, send: [] } satisfies FeedOutcome;
      }
      const { value } = message;
      if (value.kind === "ping") {
        return { send: [{ kind: "pong" }] } satisfies FeedOutcome;
      }
      if (value.kind === "hello") {
        if (row.greeted) {
          return protocolClose("Send hello once");
        }
        const result = yield* reader.catchUp({
          cursor: value.cursor ?? null,
          keyId: identity.keyId,
        });
        if (result.kind === "closed") {
          return yield* ended(identity, null);
        }
        const { cursor, messages } = feedMessages(result, true);
        const sequence = cursor === null ? null : cursorSequence(cursor);
        yield* db
          .update(feedConnections)
          .set({
            greeted: true,
            pending: sequence === null ? [] : [sequence],
            sentCursor: cursor,
          })
          .where(eq(feedConnections.id, identity.connectionId));
        return { send: messages } satisfies FeedOutcome;
      }
      const acknowledged = cursorSequence(value.cursor);
      if (!row.greeted || acknowledged === null) {
        return protocolClose("Acknowledge a cursor after hello");
      }
      const pending = row.pending.filter((sequence) => sequence > acknowledged);
      if (pending.length !== row.pending.length) {
        yield* db
          .update(feedConnections)
          .set({ ackedCursor: value.cursor, pending })
          .where(eq(feedConnections.id, identity.connectionId));
      }
      return { send: [] } satisfies FeedOutcome;
    }).pipe(Effect.mapError(transportFailure));

  const closed = (connectionId: string) =>
    forget(connectionId).pipe(Effect.asVoid, Effect.mapError(transportFailure));

  /** Drops state for sockets that no longer exist, such as after a restart. */
  const restore = (open: readonly string[]) =>
    db
      .delete(feedConnections)
      .where(notInArray(feedConnections.id, [...open]))
      .pipe(Effect.asVoid, Effect.mapError(transportFailure));

  /**
   * The SSE form of the feed. A catch-up runs only when the response pulls, so
   * a slow reader holds at most one pending wake instead of a buffer.
   */
  const live = (caller: {
    readonly keyId: string;
    readonly personId: string;
    readonly cursor: string | null;
  }) => {
    let sent = caller.cursor;
    let initial = true;
    let revoked = false;
    const wakes = Stream.callback<"change">(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            input.subscribe((notice) => {
              if (notice.kind === "revoked" && notice.keyId === caller.keyId) {
                revoked = true;
                Queue.offerUnsafe(queue, "change");
              } else if (
                notice.kind === "changed" &&
                notice.personId === caller.personId
              ) {
                Queue.offerUnsafe(queue, "change");
              }
            })
          ),
          (unsubscribe) => Effect.sync(unsubscribe)
        ),
      { bufferSize: 1, strategy: "sliding" }
    );
    const heartbeats = Stream.tick(HEARTBEAT).pipe(
      Stream.drop(1),
      Stream.map(() => "heartbeat" as const)
    );
    const closing: FeedServerMessage = {
      cursor: null,
      kind: "closing",
      reason: "revoked",
    };
    const step = (wake: "change" | "heartbeat") =>
      Effect.gen(function* nextFrames() {
        if (wake === "heartbeat") {
          return [{ kind: "heartbeat" }] satisfies FeedServerMessage[];
        }
        if (revoked) {
          return [closing];
        }
        const result = yield* reader.catchUp({
          cursor: sent,
          keyId: caller.keyId,
        });
        if (result.kind === "closed") {
          return [closing];
        }
        const frames = feedMessages(result, initial);
        initial = false;
        sent = frames.cursor;
        return frames.messages;
      });
    return Stream.concat(Stream.succeed("change" as const), wakes).pipe(
      Stream.merge(heartbeats),
      Stream.mapEffect(step),
      Stream.takeUntil((frames) =>
        frames.some((frame) => frame.kind === "closing")
      ),
      Stream.flattenIterable,
      Stream.orDie
    );
  };

  return { accept, closed, deliver, live, mintTicket, receive, restore };
};

export type FeedTransport = ReturnType<typeof makeFeedTransport>;
