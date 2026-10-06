/* oxlint-disable no-await-in-loop -- Socket frames arrive in the order the journey writes. */
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FeedServerMessage } from "@orbis/contracts";
import {
  FEED_PING,
  FEED_PROTOCOL,
  FEED_TICKET_PROTOCOL_PREFIX,
  FeedCloseCode,
  FeedServerMessageSchema,
  FeedTicketSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";

setDefaultTimeout(30_000);

const WEB_ORIGIN = "http://web.fixture.test";
const KEYS = [
  ["ana-phone", "ana"],
  ["ana-laptop", "ana"],
  ["ben-phone", "ben"],
] as const;
const tokenFor = (keyId: string) => `token-${keyId}`;
const artifacts =
  process.env.ORBIS_FEED_ARTIFACTS ??
  path.resolve(import.meta.dir, "../../../.cache/feed-transport");

const seed = async (root: string) => {
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: KEYS.map(([id, personId]) => ({
        addedAt: "2026-10-01T00:00:00.000Z",
        id,
        label: id,
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(tokenFor(id)),
      })),
      people: ["host", "ana", "ben"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: id !== "host",
        username: id,
      })),
      version: 2,
    })
  );
  const migrator = createApp({ databasePath, logging: { silent: true } });
  try {
    expect((await migrator.initialize()).status).toBe(200);
  } finally {
    await migrator.dispose();
  }
  const sqlite = new Database(databasePath);
  try {
    sqlite.run(
      `INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
       VALUES ('set-1', 'https://www.youtube.com/watch?v=set1xxxxxxx', 'set-1', 'youtube', '[]', '2026-10-01T00:00:00.000Z', 1, 'ready', 600)`
    );
    for (const personId of ["ana", "ben"]) {
      sqlite.run(
        "INSERT INTO library_entries (person_id, set_id, saved_at, tags) VALUES (?, 'set-1', '2026-10-01T00:00:00.000Z', '[]')",
        [personId]
      );
    }
  } finally {
    sqlite.close();
  }
  return databasePath;
};

test("the Bun fixture serves the ticketed socket and the SSE fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-feed-transport-"));
  const trace: unknown[] = [];
  const app = createApp({
    databasePath: await seed(root),
    logging: { silent: true },
  });
  const server = startFixtureServer({
    allowedOrigin: WEB_ORIGIN,
    app,
    port: 0,
    token: "feed-transport",
  });
  const call = async (keyId: string, route: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(route, server.url), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${tokenFor(keyId)}`,
        "content-type": "application/json",
      },
      method,
    });
    trace.push({ keyId, method, route, status: response.status });
    return response;
  };
  const mint = async (keyId: string) => {
    const response = await call(keyId, "/events/tickets", "POST", {
      protocol: FEED_PROTOCOL,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return Schema.decodeUnknownSync(FeedTicketSchema)(await response.json())
      .ticket;
  };
  const connect = (ticket: string, origin?: string) => {
    const socketUrl = new URL("/events/socket", server.url);
    socketUrl.protocol = "ws:";
    const socket = new WebSocket(socketUrl, {
      headers: origin === undefined ? {} : { Origin: origin },
      protocols: [FEED_PROTOCOL, `${FEED_TICKET_PROTOCOL_PREFIX}${ticket}`],
    } as unknown as string[]);
    const messages: FeedServerMessage[] = [];
    socket.addEventListener("message", (event) => {
      const message = Schema.decodeUnknownSync(FeedServerMessageSchema)(
        JSON.parse(String(event.data)),
        { onExcessProperty: "error" }
      );
      trace.push({ message: message.kind });
      messages.push(message);
    });
    // oxlint-disable-next-line promise/avoid-new -- The socket reports through events.
    const opened = new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true));
      socket.addEventListener("close", () => resolve(false));
    });
    // oxlint-disable-next-line promise/avoid-new -- The socket reports through events.
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code));
    });
    const next = async (kind: FeedServerMessage["kind"]) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = messages.findIndex((message) => message.kind === kind);
        if (index !== -1) {
          return messages.splice(0, index + 1).at(-1) as FeedServerMessage;
        }
        await Bun.sleep(10);
      }
      throw new Error(`no ${kind} message`);
    };
    return { closed, next, opened, socket };
  };
  try {
    const ticket = await mint("ana-phone");
    expect(await connect(ticket, "http://evil.fixture.test").opened).toBe(false);
    const ana = connect(ticket, WEB_ORIGIN);
    expect(await ana.opened).toBe(true);
    expect(ana.socket.protocol).toBe(FEED_PROTOCOL);
    expect(await connect(ticket).opened).toBe(false);
    ana.socket.send(JSON.stringify({ kind: "hello" }));
    await ana.next("snapshot");
    const ready = await ana.next("ready");
    ana.socket.send(FEED_PING);
    await ana.next("pong");

    const laptop = connect(await mint("ana-laptop"));
    expect(await laptop.opened).toBe(true);
    laptop.socket.send(JSON.stringify({ kind: "hello" }));
    await laptop.next("ready");

    expect(
      (await call("ana-phone", "/sets/set-1/tags", "PATCH", { tags: ["bun"] }))
        .status
    ).toBe(200);
    const change = await ana.next("changes");
    expect(change.kind === "changes" && change.deliveries[0]?.body).toEqual({
      kind: "invalidate",
      resourceId: "set-1",
      topic: "library",
    });

    const live = await call(
      "ben-phone",
      `/events/live?cursor=${ready.kind === "ready" ? ready.cursor : ""}`
    );
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toStartWith("text/event-stream");
    const reader = live.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain('"kind":"reset"');
    await reader?.cancel();

    expect(
      (await call("ana-phone", "/me/devices/ana-laptop", "DELETE")).status
    ).toBe(200);
    expect(await laptop.closed).toBe(FeedCloseCode.closed);
    ana.socket.close();
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(artifacts, `bun-${Date.now()}.json`),
      `${JSON.stringify(trace, null, 2)}\n`
    );
  } finally {
    await server.stop();
    await rm(root, { force: true, recursive: true });
  }
});
