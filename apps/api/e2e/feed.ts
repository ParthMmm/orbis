/* oxlint-disable no-await-in-loop -- Ordered requests and socket frames define the journey. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FeedServerMessage, NodeMessage } from "@orbis/contracts";
import {
  FEED_ACK_WINDOW,
  FEED_PING,
  FEED_PROTOCOL,
  FEED_TICKET_PROTOCOL_PREFIX,
  FeedCloseCode,
  FeedServerMessageSchema,
  FeedTicketSchema,
  OrbisApi,
  PresenceActionResultSchema,
  QueueEventSchema,
} from "@orbis/contracts/http-api";
import { NodeCommandSchema } from "@orbis/contracts/node";
import type { NodeCommand } from "@orbis/contracts/node";
import { Effect, Fiber, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Miniflare } from "miniflare";

import { makeNodeHttpHandler } from "../../server/src/node-http.js";

const artifact = path.resolve(
  process.env.ORBIS_FEED_ARTIFACTS ??
    path.resolve(import.meta.dir, "../../../.cache/api-feed"),
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "feed-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);

const runtimeLog: string[] = [];
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ef".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  handleRuntimeStdio: (stdout, stderr) => {
    for (const stream of [stdout, stderr]) {
      stream.on("data", (chunk: Buffer) => runtimeLog.push(chunk.toString()));
    }
  },
  host: "127.0.0.1",
  modules: true,
  port: 0,
  script: await output.text(),
});
const base = await runtime.ready;

const secrets = new Map<string, string>();
const keep = (value: string, label: string) => {
  secrets.set(value, label);
  return value;
};
const token = (keyId: string) => keep(`token-${keyId}`, `[token ${keyId}]`);
const redact = (text: string) => {
  let result = text;
  for (const [secret, label] of secrets) {
    result = result.replaceAll(secret, label);
  }
  return result.replaceAll(
    /"cursor":"(?<cursor>[A-Za-z0-9_-]+)"/gu,
    (_match, cursor: string) =>
      `"cursor":"cursor#${createHash("sha256").update(cursor).digest("hex").slice(0, 8)}"`
  );
};
type TraceEntry = Readonly<Record<string, string | number | null>>;
const trace: TraceEntry[] = [];
const note = (entry: TraceEntry) =>
  trace.push({ at: new Date().toISOString(), ...entry });
const results: Record<string, "pass"> = {};
const passed = (name: string) => {
  results[name] = "pass";
  note({ kind: "pass", name });
  console.log(`pass ${name}`);
};

interface CallHeaders {
  "CF-Connecting-IP": string;
  "content-type": string;
  authorization?: string;
}

const call = async (
  keyId: string | null,
  route: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) => {
  const method = init.method ?? "GET";
  const headers: CallHeaders = {
    "CF-Connecting-IP": "192.0.2.10",
    "content-type": "application/json",
  };
  if (keyId !== null) {
    headers.authorization = `Bearer ${token(keyId)}`;
  }
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { ...headers, ...init.headers },
    method,
  });
  const text = await response.text();
  note({
    keyId,
    kind: "http",
    method,
    response: text.length > 600 ? `${text.slice(0, 600)}…` : text,
    route,
    status: response.status,
  });
  return { headers: response.headers, status: response.status, text };
};

const mint = async (keyId: string) => {
  const response = await call(keyId, "/events/tickets", {
    body: { protocol: FEED_PROTOCOL },
    method: "POST",
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const ticket = Schema.decodeUnknownSync(FeedTicketSchema)(
    JSON.parse(response.text)
  );
  keep(ticket.ticket, `[ticket for ${keyId}]`);
  return ticket;
};

interface FeedClient {
  readonly label: string;
  readonly messages: FeedServerMessage[];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly send: (text: string) => void;
  readonly hello: (cursor?: string) => void;
  readonly next: (
    matches: (message: FeedServerMessage) => boolean,
    timeoutMs?: number
  ) => Promise<FeedServerMessage>;
  readonly lastCursor: () => string | null;
  readonly close: () => void;
}

interface UpgradeHeaders {
  Upgrade: "websocket";
  "Sec-WebSocket-Protocol"?: string;
}

const upgrade = (
  protocols: string | null,
  headers: Record<string, string> = {},
  route = "/events/socket"
) => {
  const upgradeHeaders: UpgradeHeaders = { Upgrade: "websocket" };
  if (protocols !== null) {
    upgradeHeaders["Sec-WebSocket-Protocol"] = protocols;
  }
  return runtime.dispatchFetch(`http://orbis/api${route}`, {
    headers: { ...upgradeHeaders, ...headers },
  });
};

const attach = (
  label: string,
  response: Response,
  options: { readonly ack: boolean }
): FeedClient => {
  const socket = response.webSocket;
  assert.ok(socket, `${label} has a socket`);
  socket.accept();
  const messages: FeedServerMessage[] = [];
  let cursor: string | null = null;
  const waiters = new Set<() => void>();
  const send = (text: string) => {
    note({ kind: "socket-out", label, text: redact(text) });
    socket.send(text);
  };
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    note({ kind: "socket-in", label, text: redact(text) });
    const message = Schema.decodeUnknownSync(FeedServerMessageSchema)(
      JSON.parse(text),
      { onExcessProperty: "error" }
    );
    messages.push(message);
    if (
      message.kind === "changes" ||
      message.kind === "snapshot" ||
      message.kind === "ready"
    ) {
      ({ cursor } = message);
    }
    if (
      options.ack &&
      cursor !== null &&
      (message.kind === "changes" || message.kind === "snapshot")
    ) {
      send(JSON.stringify({ cursor, kind: "ack" }));
    }
    for (const wake of waiters) {
      wake();
    }
  });
  // oxlint-disable-next-line promise/avoid-new -- The socket reports its close through an event.
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => {
      note({
        code: event.code,
        kind: "socket-close",
        label,
        reason: event.reason,
      });
      resolve({ code: event.code, reason: event.reason });
    });
  });
  let seen = 0;
  const next = async (
    matches: (message: FeedServerMessage) => boolean,
    timeoutMs = 5000
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      while (seen < messages.length) {
        const message = messages[seen];
        seen += 1;
        if (message && matches(message)) {
          return message;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `${label} timed out; saw ${redact(JSON.stringify(messages.slice(-5)))}`
        );
      }
      // oxlint-disable-next-line promise/avoid-new -- Frames arrive through socket events.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
    }
  };
  return {
    close: () => socket.close(1000, "done"),
    closed,
    hello: (resume) =>
      send(
        JSON.stringify(
          resume === undefined
            ? { kind: "hello" }
            : { cursor: resume, kind: "hello" }
        )
      ),
    label,
    lastCursor: () => cursor,
    messages,
    next,
    send,
  };
};

const open = async (
  keyId: string,
  options: { readonly ack?: boolean; readonly label?: string } = {}
) => {
  const { ticket } = await mint(keyId);
  const response = await upgrade(
    `${FEED_PROTOCOL}, ${FEED_TICKET_PROTOCOL_PREFIX}${ticket}`
  );
  assert.equal(response.status, 101, await response.text());
  assert.equal(response.headers.get("sec-websocket-protocol"), FEED_PROTOCOL);
  return attach(options.label ?? keyId, response, { ack: options.ack ?? true });
};

const presenceOf = (message: FeedServerMessage) =>
  message.kind === "changes"
    ? message.deliveries.flatMap((delivery) =>
        delivery.body.kind === "presence" ? [delivery.body.presence] : []
      )
    : [];
const hasPresence = (personId: string | null) => (message: FeedServerMessage) =>
  presenceOf(message).some((presence) =>
    personId === null
      ? presence.length === 0
      : presence.some((entry) => entry.personId === personId)
  );
const invalidates =
  (topic: string, resourceId?: string) => (message: FeedServerMessage) =>
    message.kind === "changes" &&
    message.deliveries.some(
      (delivery) =>
        delivery.body.kind === "invalidate" &&
        delivery.body.topic === topic &&
        (resourceId === undefined || delivery.body.resourceId === resourceId)
    );
const queued = (message: FeedServerMessage) =>
  message.kind === "changes" &&
  message.deliveries.some((delivery) => delivery.body.kind === "queue");

const FeedState = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      connectionId: Schema.String,
      keyId: Schema.String,
      personId: Schema.String,
    })
  ),
  connections: Schema.Array(
    Schema.Struct({
      acked: Schema.Number,
      greeted: Schema.Number,
      id: Schema.String,
      key_id: Schema.String,
      person_id: Schema.String,
      unacknowledged: Schema.Number,
    })
  ),
  constructions: Schema.Array(Schema.Number),
  nodeSockets: Schema.Number,
  tickets: Schema.Number,
});
const feedState = async () => {
  const response = await call(null, "/__feed-state");
  assert.equal(response.status, 200, response.text);
  return Schema.decodeUnknownSync(FeedState)(JSON.parse(response.text));
};

let actionNumber = 0;
const act = async (
  keyId: string,
  action:
    | { readonly kind: "play"; readonly setId: string }
    | { readonly kind: "pause" | "stop"; readonly ownerGeneration: number },
  sessionId = `${keyId}-session`
) => {
  actionNumber += 1;
  const response = await call(keyId, "/presence/actions", {
    body: {
      ...action,
      actionId: `${sessionId}-${actionNumber}`,
      actionNumber,
      sessionId,
    },
    method: "POST",
  });
  assert.equal(response.status, 200, response.text);
  return Schema.decodeUnknownSync(PresenceActionResultSchema)(
    JSON.parse(response.text)
  );
};

const readSse = (response: Response, label: string) => {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messages: FeedServerMessage[] = [];
  let buffer = "";
  let ended = false;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          note({ kind: "sse-end", label });
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data === "") {
            continue;
          }
          note({ kind: "sse-in", label, text: redact(data) });
          messages.push(
            Schema.decodeUnknownSync(FeedServerMessageSchema)(
              JSON.parse(data),
              {
                onExcessProperty: "error",
              }
            )
          );
        }
      }
    } catch {
      ended = true;
    }
  })();
  let seen = 0;
  const next = async (
    matches: (message: FeedServerMessage) => boolean,
    timeoutMs = 5000
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (seen < messages.length) {
        const message = messages[seen];
        seen += 1;
        if (message && matches(message)) {
          return message;
        }
      }
      await Bun.sleep(20);
    }
    throw new Error(
      `${label} SSE timed out; saw ${redact(JSON.stringify(messages.slice(-5)))}`
    );
  };
  return {
    cancel: () => reader.cancel(),
    ended: () => ended,
    messages,
    next,
    pump,
  };
};

const sse = async (
  keyId: string,
  cursor?: string,
  origin: string = base.toString()
) => {
  const url = new URL("api/events/live", origin);
  if (cursor !== undefined) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token(keyId)}` },
  });
  note({
    keyId,
    kind: "http",
    method: "GET",
    route:
      cursor === undefined ? "/events/live" : "/events/live?cursor=[cursor]",
    status: response.status,
    via: origin === base.toString() ? "worker" : "forwarder",
  });
  return response;
};

let forwarder: ReturnType<typeof Bun.serve> | undefined;
try {
  const seeded = await call(null, "/__seed-feed");
  assert.equal(seeded.status, 200);

  // Ticket contract: daily keys only, fixed protocol, no-store, 30 seconds.
  const minted = await mint("ana-phone");
  const expiresIn = Date.parse(minted.expiresAt) - Date.now();
  assert.ok(
    expiresIn > 28_000 && expiresIn <= 30_000,
    `expires in ${expiresIn}`
  );
  assert.equal(minted.protocol, FEED_PROTOCOL);
  const wrongProtocol = await call("ana-phone", "/events/tickets", {
    body: { protocol: "orbis.feed.v2" },
    method: "POST",
  });
  assert.equal(wrongProtocol.status, 400);
  for (const keyId of ["host-admin", "vanta-node"]) {
    const refused = await call(keyId, "/events/tickets", {
      body: { protocol: FEED_PROTOCOL },
      method: "POST",
    });
    assert.equal(refused.status, 403, `${keyId}: ${refused.text}`);
  }
  const anonymous = await call(null, "/events/tickets", {
    body: { protocol: FEED_PROTOCOL },
    method: "POST",
  });
  assert.equal(anonymous.status, 403);
  passed("ticket-scope");

  // Wrong Origin fails before the ticket is consumed.
  const offered = `${FEED_PROTOCOL}, ${FEED_TICKET_PROTOCOL_PREFIX}${minted.ticket}`;
  const foreign = await upgrade(offered, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403, await foreign.text());
  assert.equal(foreign.webSocket, null);
  passed("wrong-origin");

  const first = await upgrade(offered, { Origin: "http://orbis" });
  assert.equal(first.status, 101, await first.text());
  assert.equal(first.headers.get("sec-websocket-protocol"), FEED_PROTOCOL);
  const anaPhone = attach("ana-phone#1", first, { ack: true });
  anaPhone.hello();
  const snapshot = await anaPhone.next(
    (message) => message.kind === "snapshot"
  );
  assert.equal(snapshot.kind, "snapshot");
  await anaPhone.next((message) => message.kind === "ready");
  assert.ok(
    !anaPhone.messages.some((message) => message.kind === "reset"),
    "a first hello gets no reset"
  );
  passed("upgrade");

  const replay = await upgrade(offered);
  assert.equal(replay.status, 401, await replay.text());
  assert.equal(replay.webSocket, null);
  passed("ticket-replay");

  // Only a ticket opens a socket: never a header key, a URL key, or a node key.
  for (const [label, response] of [
    [
      "daily bearer",
      await upgrade(FEED_PROTOCOL, {
        authorization: `Bearer ${token("ana-phone")}`,
      }),
    ],
    [
      "node bearer",
      await upgrade(FEED_PROTOCOL, {
        authorization: `Bearer ${token("vanta-node")}`,
      }),
    ],
    [
      "url key",
      await upgrade(
        FEED_PROTOCOL,
        {},
        `/events/socket?key=${token("ana-phone")}`
      ),
    ],
    ["no protocol", await upgrade(null)],
  ] as const) {
    assert.ok(
      [400, 401].includes(response.status),
      `${label} answered ${response.status}`
    );
    assert.equal(response.webSocket, null, label);
  }
  const plain = await call("ana-phone", "/events/socket");
  assert.equal(plain.status, 426, plain.text);
  passed("wrong-scope");

  // #209: a committed Presence transition reaches a viewer over the feed.
  const benPhone = await open("ben-phone");
  benPhone.hello();
  await benPhone.next((message) => message.kind === "ready");
  const activated = await call("ana-phone", "/queue/active", {
    body: { setId: "set-1" },
    method: "PUT",
  });
  assert.equal(activated.status, 200);
  await anaPhone.next(queued);
  const played = await act("ana-phone", { kind: "play", setId: "set-1" });
  await benPhone.next(hasPresence("ana"));
  await act("ana-phone", {
    kind: "pause",
    ownerGeneration: played.session.ownerGeneration,
  });
  await benPhone.next(hasPresence(null));
  passed("presence-transition-reaches-viewer");

  // Reconnection resumes from the last applied cursor without a snapshot.
  const resume = anaPhone.lastCursor();
  assert.ok(resume);
  anaPhone.close();
  await anaPhone.closed;
  const missed = await call("ana-phone", "/sets/set-2/tags", {
    body: { tags: ["missed"] },
    method: "PATCH",
  });
  assert.equal(missed.status, 200);
  const anaAgain = await open("ana-phone", { label: "ana-phone#2" });
  anaAgain.hello(resume);
  await anaAgain.next(invalidates("library", "set-2"));
  await anaAgain.next((message) => message.kind === "ready");
  assert.ok(
    !anaAgain.messages.some(
      (message) => message.kind === "snapshot" || message.kind === "reset"
    ),
    "a current cursor resumes without a reset"
  );
  const laptop = await open("ana-laptop", { label: "ana-laptop#1" });
  laptop.hello(resume);
  const foreignCursor = await laptop.next(
    (message) => message.kind === "reset"
  );
  assert.equal(
    foreignCursor.kind === "reset" && foreignCursor.reason,
    "invalid"
  );
  await laptop.next((message) => message.kind === "snapshot");
  await laptop.next((message) => message.kind === "ready");
  passed("reconnect-with-cursor");

  // An authorization epoch change voids an unused ticket and resets open sockets.
  const stale = await mint("ana-phone");
  const unsocial = await call("ben-phone", "/me", {
    body: { social: false },
    method: "PATCH",
  });
  assert.equal(unsocial.status, 200);
  const epochReset = await anaAgain.next((message) => message.kind === "reset");
  assert.equal(epochReset.kind === "reset" && epochReset.reason, "access");
  await anaAgain.next((message) => message.kind === "snapshot");
  await anaAgain.next((message) => message.kind === "ready");
  const staleUpgrade = await upgrade(
    `${FEED_PROTOCOL}, ${FEED_TICKET_PROTOCOL_PREFIX}${stale.ticket}`
  );
  assert.equal(staleUpgrade.status, 401, await staleUpgrade.text());
  const social = await call("ben-phone", "/me", {
    body: { social: true },
    method: "PATCH",
  });
  assert.equal(social.status, 200);
  await benPhone.next((message) => message.kind === "ready");
  passed("wrong-key-epoch");

  // A client that stops acknowledging is cut off with a resumable cursor.
  const slow = await open("ana-tablet", {
    ack: false,
    label: "ana-tablet#slow",
  });
  slow.hello();
  await slow.next((message) => message.kind === "ready");
  for (let index = 0; index <= FEED_ACK_WINDOW + 1; index += 1) {
    const response = await call("ana-phone", "/sets/set-1/tags", {
      body: { tags: [`slow-${index}`] },
      method: "PATCH",
    });
    assert.equal(response.status, 200, response.text);
    if (
      (await Promise.race([slow.closed, Bun.sleep(30).then(() => null)])) !==
      null
    ) {
      break;
    }
  }
  const slowClose = await slow.closed;
  assert.equal(slowClose.code, FeedCloseCode.slow);
  const closing = slow.messages.at(-1);
  assert.equal(closing?.kind, "closing");
  assert.equal(closing?.kind === "closing" && closing.reason, "slow");
  assert.ok(
    anaAgain.messages.filter((message) => message.kind === "changes").length >
      FEED_ACK_WINDOW,
    "an acknowledging socket stays open through the same changes"
  );
  passed("slow-client");

  // Hibernation: quiet sockets survive eviction; the node socket dispatches separately.
  const nodeResponse = await runtime.dispatchFetch("http://orbis/api/node", {
    headers: {
      Upgrade: "websocket",
      authorization: `Bearer ${token("vanta-node")}`,
    },
  });
  assert.equal(nodeResponse.status, 101, await nodeResponse.text());
  const nodeSocket = nodeResponse.webSocket;
  assert.ok(nodeSocket);
  nodeSocket.accept();
  const commands: NodeCommand[] = [];
  // oxlint-disable-next-line promise/avoid-new -- The node socket reports its close through an event.
  const nodeClosed = new Promise<{ code: number; reason: string }>(
    (resolve) => {
      nodeSocket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason })
      );
    }
  );
  nodeSocket.addEventListener("message", (event) => {
    note({ kind: "node-in", text: String(event.data) });
    commands.push(
      Schema.decodeUnknownSync(NodeCommandSchema)(
        JSON.parse(String(event.data))
      )
    );
  });
  const sendNode = (message: NodeMessage | { readonly kind: "hello" }) => {
    note({ kind: "node-out", text: JSON.stringify(message) });
    nodeSocket.send(JSON.stringify(message));
  };
  sendNode({
    files: ["set-1", "set-2", "orphan-file"].map((setId) => ({
      bytes: 10,
      durationSeconds: 1,
      format: "m4a" as const,
      setId,
    })),
    kind: "inventory",
  });
  const released = async (setId: string) => {
    const deadline = Date.now() + 5000;
    while (
      !commands.some(
        (command) => command.kind === "release" && command.setId === setId
      )
    ) {
      assert.ok(Date.now() < deadline, `node release for ${setId}`);
      await Bun.sleep(20);
    }
  };
  await released("orphan-file");

  const leased = await act("ana-phone", { kind: "play", setId: "set-1" });
  await benPhone.next(hasPresence("ana"));
  assert.equal(leased.session.state, "playing");
  const deadline =
    leased.session.state === "playing"
      ? Date.parse(leased.session.leaseExpiresAt)
      : 0;
  const expiring = await mint("ana-phone");
  const quietSince = Date.now();
  await Bun.sleep(12_000);
  const pingAt = Date.now();
  benPhone.send(FEED_PING);
  await benPhone.next((message) => message.kind === "pong");
  await Bun.sleep(300);
  const probedAt = Date.now();
  const evicted = await feedState();
  assert.ok(
    !evicted.constructions.some((at) => at >= pingAt && at < probedAt),
    "an automatic ping reply does not construct the Group"
  );
  assert.ok(
    evicted.constructions.some((at) => at >= probedAt),
    "the Group was evicted while sockets stayed open"
  );
  assert.ok(
    evicted.attachments.some((attached) => attached.keyId === "ben-phone")
  );
  assert.equal(evicted.nodeSockets, 1);
  passed("ping-without-wake");

  // The lease alarm wakes an evicted Group and its expiry reaches a restored socket.
  const expiry = await benPhone.next(
    hasPresence(null),
    deadline - Date.now() + 15_000
  );
  assert.ok(expiry);
  const afterAlarm = await feedState();
  assert.ok(
    afterAlarm.constructions.some(
      (at) => at >= deadline - 1000 && at <= deadline + 5000
    ),
    `an alarm constructed the Group near ${new Date(deadline).toISOString()}`
  );
  assert.ok(quietSince < deadline);
  passed("hibernation-restore");

  const expired = await upgrade(
    `${FEED_PROTOCOL}, ${FEED_TICKET_PROTOCOL_PREFIX}${expiring.ticket}`
  );
  assert.ok(Date.now() > Date.parse(expiring.expiresAt));
  assert.equal(expired.status, 401, await expired.text());
  passed("ticket-expiry");

  // Both socket kinds dispatch on their own paths after another eviction.
  await Bun.sleep(12_000);
  const evictedAgainAt = Date.now();
  const saved = await call("ana-phone", "/sets", {
    body: {
      tags: [],
      title: "Node fixture",
      url: "https://soundcloud.com/fixture/feed-node",
    },
    method: "POST",
  });
  assert.equal(saved.status, 201, saved.text);
  const { id: savedId } = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.String })
  )(JSON.parse(saved.text));
  const restarted = await feedState();
  assert.ok(restarted.constructions.some((at) => at >= evictedAgainAt));
  const start = await (async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const found = commands.find(
        (command) => command.kind === "start" && command.setId === savedId
      );
      if (found) {
        return found;
      }
      await Bun.sleep(20);
    }
    throw new Error("the restored Group sent no start command");
  })();
  await anaAgain.next(invalidates("library", savedId));
  sendNode({
    bytes: 4096,
    durationSeconds: 60,
    format: "m4a",
    kind: "finished",
    requestId: start.requestId,
    setId: savedId,
  });
  const AudioState = Schema.Struct({ state: Schema.String });
  const state = async () => {
    const response = await call("ana-phone", `/sets/${savedId}/audio/state`);
    return Schema.decodeUnknownSync(AudioState)(JSON.parse(response.text))
      .state;
  };
  const readyBy = Date.now() + 5000;
  while ((await state()) !== "ready") {
    assert.ok(
      Date.now() < readyBy,
      "the node finish reached the restored Group"
    );
    await Bun.sleep(50);
  }
  anaAgain.send(JSON.stringify({ files: [], kind: "inventory" }));
  const misrouted = await anaAgain.closed;
  assert.equal(misrouted.code, FeedCloseCode.protocol);
  sendNode({ kind: "hello" });
  const nodeMisrouted = await nodeClosed;
  assert.equal(nodeMisrouted.code, 1008);
  assert.equal(nodeMisrouted.reason, "Invalid node message");
  passed("node-and-client-dispatch");

  // Revocation closes every socket and stream for the key right after it commits.
  const revokedSocket = await open("ana-laptop", { label: "ana-laptop#2" });
  revokedSocket.hello();
  await revokedSocket.next((message) => message.kind === "ready");
  const revokedStream = readSse(await sse("ana-laptop"), "ana-laptop sse");
  await revokedStream.next((message) => message.kind === "ready");
  const revokedAt = Date.now();
  const revoked = await call("ana-phone", "/me/devices/ana-laptop", {
    method: "DELETE",
  });
  assert.equal(revoked.status, 200);
  const revokedClose = await revokedSocket.closed;
  assert.equal(revokedClose.code, FeedCloseCode.closed);
  assert.ok(Date.now() - revokedAt < 2000, "the socket closed promptly");
  const revokedLast = revokedSocket.messages.at(-1);
  assert.equal(
    revokedLast?.kind === "closing" && revokedLast.reason,
    "revoked"
  );
  await revokedStream.pump;
  assert.ok(revokedStream.ended(), "the SSE stream for the key ended");
  assert.equal(laptop.messages.length > 0, true);
  const laptopClose = await laptop.closed;
  assert.equal(laptopClose.code, FeedCloseCode.closed);
  const refused = await call("ana-laptop", "/events/tickets", {
    body: { protocol: FEED_PROTOCOL },
    method: "POST",
  });
  assert.equal(refused.status, 401, refused.text);
  const afterRevoke = await feedState();
  assert.ok(
    !afterRevoke.connections.some((row) => row.key_id === "ana-laptop")
  );
  passed("revoked-key");

  // SSE fallback: same messages, cursor in the query, heartbeat kept.
  const live = readSse(await sse("ben-phone"), "ben-phone sse");
  const liveReady = await live.next((message) => message.kind === "ready");
  assert.ok(live.messages.some((message) => message.kind === "snapshot"));
  const sseCursor = liveReady.kind === "ready" ? liveReady.cursor : "";
  const sseAgain = await act("ana-phone", { kind: "play", setId: "set-1" });
  await live.next(hasPresence("ana"));
  await live.cancel();
  await act("ana-phone", {
    kind: "stop",
    ownerGeneration: sseAgain.session.ownerGeneration,
  });
  const resumed = readSse(await sse("ben-phone", sseCursor), "ben-phone sse#2");
  await resumed.next(hasPresence(null));
  await resumed.next((message) => message.kind === "ready");
  assert.ok(!resumed.messages.some((message) => message.kind === "snapshot"));
  await resumed.next((message) => message.kind === "heartbeat", 35_000);
  await resumed.cancel();
  for (const keyId of ["host-admin", "vanta-node"]) {
    const refusedStream = await sse(keyId);
    assert.equal(refusedStream.status, 403, keyId);
  }
  passed("sse-live");

  // The deployed /events decoder still receives only its own union.
  const oldEvents: unknown[] = [];
  const oldFiber = Effect.runFork(
    Effect.gen(function* readOldEvents() {
      const client = yield* HttpApiClient.make(OrbisApi, {
        baseUrl: new URL("api", base).toString(),
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${token("ben-phone")}`
          )
        ),
      });
      const events = yield* client.events.subscribe();
      yield* events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            oldEvents.push(event);
            note({ kind: "events-in", text: redact(JSON.stringify(event)) });
          })
        )
      );
    }).pipe(Effect.provide(FetchHttpClient.layer))
  );
  await Bun.sleep(500);
  const activatedAgain = await call("ana-phone", "/queue/active", {
    body: { setId: "set-2" },
    method: "PUT",
  });
  assert.equal(activatedAgain.status, 200);
  const oldPlay = await act(
    "ana-phone",
    { kind: "play", setId: "set-2" },
    "old-decoder"
  );
  await call("ana-phone", "/sets/set-2/tags", {
    body: { tags: ["old"] },
    method: "PATCH",
  });
  await act(
    "ana-phone",
    {
      kind: "pause",
      ownerGeneration: oldPlay.session.ownerGeneration,
    },
    "old-decoder"
  );
  await Bun.sleep(3000);
  await Effect.runPromise(Fiber.interrupt(oldFiber));
  assert.ok(
    oldEvents.length >= 2,
    `old decoder read ${oldEvents.length} events`
  );
  const decodedOld = oldEvents.map((event) =>
    Schema.decodeUnknownSync(QueueEventSchema)(event, {
      onExcessProperty: "error",
    })
  );
  for (const event of decodedOld) {
    assert.ok(["queue", "presence", "heartbeat"].includes(event.kind));
  }
  assert.ok(
    decodedOld.some(
      (event) =>
        event.kind === "presence" &&
        event.presence.some((entry) => entry.personId === "ana")
    ),
    "the old stream still shows Presence"
  );
  passed("old-decoder");

  // Through the Vanta forwarder an upgrade is unavailable, and SSE carries the same feed.
  forwarder = Bun.serve({
    fetch: makeNodeHttpHandler({
      apiUrl: new URL("api", base),
      audioDir: path.join(artifact, "audio"),
      logging: { silent: true },
      streamSecret: Buffer.from("ef".repeat(32), "hex"),
    }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const fallbackTicket = await mint("ana-phone");
  const viaForwarder = await fetch(
    new URL("/api/events/socket", forwarder.url),
    {
      headers: {
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": `${FEED_PROTOCOL}, ${FEED_TICKET_PROTOCOL_PREFIX}${fallbackTicket.ticket}`,
        "Sec-WebSocket-Version": "13",
        Upgrade: "websocket",
      },
    }
  );
  note({
    kind: "http",
    route: "/events/socket",
    status: viaForwarder.status,
    via: "forwarder",
  });
  assert.equal(viaForwarder.status, 426, await viaForwarder.text());
  // oxlint-disable-next-line promise/avoid-new -- A browser-style client reports failure through events.
  const browserOutcome = await new Promise<string>((resolve) => {
    const client = new WebSocket(
      new URL("/api/events/socket", forwarder?.url)
        .toString()
        .replace("http", "ws"),
      [FEED_PROTOCOL, `${FEED_TICKET_PROTOCOL_PREFIX}${fallbackTicket.ticket}`]
    );
    client.addEventListener("open", () => resolve("open"));
    client.addEventListener("error", () => resolve("error"));
    client.addEventListener("close", () => resolve("close"));
  });
  note({ kind: "socket-attempt", outcome: browserOutcome, via: "forwarder" });
  assert.notEqual(browserOutcome, "open");
  const fallback = readSse(
    await sse("ana-phone", undefined, forwarder.url.toString()),
    "ana-phone fallback sse"
  );
  await fallback.next((message) => message.kind === "snapshot");
  await fallback.next((message) => message.kind === "ready");
  const fallbackActivated = await call("ana-phone", "/queue/active", {
    body: { setId: "set-1" },
    method: "PUT",
  });
  assert.equal(fallbackActivated.status, 200);
  await fallback.next(queued);
  await fallback.cancel();
  passed("upgrade-unavailable-sse-fallback");

  const logs = runtimeLog.join("");
  for (const [secret, label] of secrets) {
    assert.ok(!logs.includes(secret), `runtime logs leak ${label}`);
  }
  assert.ok(!/cursor=/u.test(logs), "runtime logs leak a cursor query");
  assert.ok(logs.includes("/events/socket"), "upgrades are logged");
  passed("redacted-logs");

  await writeFile(
    path.join(artifact, "trace.json"),
    `${redact(JSON.stringify(trace, null, 2))}\n`
  );
  await writeFile(
    path.join(artifact, "runtime.log"),
    redact(
      logs
        .split("\n")
        .filter((line) => line.includes("/events"))
        .join("\n")
    )
  );
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(results, null, 2)}\n`
  );
  console.log(
    `Feed transport journey passed. ${path.join(artifact, "result.json")}`
  );
} catch (error) {
  await writeFile(
    path.join(artifact, "trace.json"),
    `${redact(JSON.stringify(trace, null, 2))}\n`
  );
  await writeFile(
    path.join(artifact, "runtime.log"),
    redact(runtimeLog.join(""))
  );
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify({ ...results, failed: String(error) }, null, 2)}\n`
  );
  console.error(`Feed journey failed; trace in ${artifact}`);
  throw error;
} finally {
  await forwarder?.stop(true);
  await runtime.dispose();
}
