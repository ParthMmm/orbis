/* oxlint-disable no-await-in-loop -- SSE frames and ordered client actions are observed in sequence. */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ListeningQueueSchema,
  QueueEventSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";

// The union that shipped before `changed` existed: what a cached web bundle decodes with.
const OldEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queue"), queue: ListeningQueueSchema }),
  Schema.Struct({
    kind: Schema.Literal("presence"),
    presence: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ kind: Schema.Literal("heartbeat") }),
]);
const decodeOld = Schema.decodeUnknownSync(Schema.fromJsonString(OldEvent));
const decodeNew = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueueEventSchema)
);

const KEYS = { a1: "a", a2: "a", b1: "b", c1: "c" } as const;
type Key = keyof typeof KEYS;

let root = "";
let url: URL;
let stop: () => Promise<void>;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "orbis-changes-"));
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: Object.entries(KEYS).map(([id, personId]) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: [
        { id: "host", removed: false, social: false, username: "host" },
        { id: "a", removed: false, social: true, username: "a" },
        { id: "b", removed: false, social: true, username: "b" },
        {
          // c hides from b and does not look at a.
          filters: [
            { appear: false, personId: "b", see: true },
            { appear: true, personId: "a", see: false },
          ],
          id: "c",
          removed: false,
          social: true,
          username: "c",
        },
      ],
      version: 2,
    })
  );
  const migrator = createApp({ databasePath, logging: { silent: true } });
  const health = await migrator.initialize();
  expect(health.status).toBe(200);
  await migrator.dispose();
  const sqlite = new Database(databasePath);
  sqlite.run(
    `INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
     VALUES ('s1', 'https://www.youtube.com/watch?v=s1xxxxxxxxx', 's1', 'youtube', '[]', '2026-04-01T00:00:00.000Z', 1, 'ready', 600)`
  );
  for (const personId of ["a", "b", "c"]) {
    sqlite.run(
      "INSERT INTO library_entries (person_id, set_id, saved_at, tags) VALUES (?, 's1', '2026-04-01T00:00:00.000Z', '[]')",
      [personId]
    );
  }
  sqlite.close();
  const listeners = await startFixtureServer({
    app: createApp({ databasePath, logging: { silent: true } }),
    port: 0,
    token: "seeded-test-fixture",
  });
  url = new URL(listeners.url);
  stop = () => listeners.stop();
});

afterAll(async () => {
  await stop();
  await rm(root, { force: true, recursive: true });
});

type Body = { name: string } | { setId: string } | { tags: string[] };
const Created = Schema.Struct({ id: Schema.String });

const call = async (key: Key, route: string, method = "GET", body?: Body) => {
  const init: RequestInit = {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(route, url), init);
  expect(response.status).toBeLessThan(300);
  return response.json();
};

/** Opens `/events` and yields raw `data:` payloads in arrival order. */
const open = async (key: Key, route = "/events?changes=1") => {
  const response = await fetch(new URL(route, url), {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("The event response has no stream");
  }
  const decoder = new TextDecoder();
  let pending = "";
  const data = async () => {
    while (!pending.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        return null;
      }
      pending += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = pending.indexOf("\n\n");
    const frame = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
  };
  return {
    close: () => reader.cancel().catch(() => null),
    data,
    /** The next `changed` topic, skipping Queue, Presence, and heartbeat frames. */
    nextTopic: async () => {
      for (;;) {
        const raw = await data();
        if (raw === null) {
          throw new Error("The event stream closed");
        }
        const event = decodeNew(raw);
        if (event.kind === "changed") {
          return event.topic;
        }
      }
    },
  };
};

const tagA = (tag: string) =>
  call("a2", "/sets/s1/tags", "PATCH", { tags: [tag] });
const tagC = (tag: string) =>
  call("c1", "/sets/s1/tags", "PATCH", { tags: [tag] });

test("a Library change on one device reaches the Person's other device only", async () => {
  const a1 = await open("a1");
  const b1 = await open("b1");
  try {
    await tagA("one");
    expect(await a1.nextTopic()).toBe("library");
    await call("b1", "/playlists", "POST", { name: "Marker" });
    // b's first change is its own: a's Library change never reached b.
    expect(await b1.nextTopic()).toBe("playlist");
  } finally {
    await a1.close();
    await b1.close();
  }
}, 10_000);

test("a Playlist edit reaches a reader but not a Person who cannot read it", async () => {
  const b1 = await open("b1");
  const c1 = await open("c1");
  try {
    const playlist = Schema.decodeUnknownSync(Created)(
      await call("a2", "/playlists", "POST", { name: "Mix" })
    );
    expect(await b1.nextTopic()).toBe("playlist");
    await call("a2", `/playlists/${playlist.id}`, "PATCH", { name: "Mix 2" });
    expect(await b1.nextTopic()).toBe("playlist");
    await tagC("marker");
    expect(await c1.nextTopic()).toBe("library");
  } finally {
    await b1.close();
    await c1.close();
  }
}, 10_000);

test("a hidden Person's Listen reaches who can see them and nobody else", async () => {
  const a1 = await open("a1");
  const b1 = await open("b1");
  const c1 = await open("c1");
  try {
    await call("c1", "/queue/active", "PUT", { setId: "s1" });
    expect(await c1.nextTopic()).toBe("listen-history");
    expect(await a1.nextTopic()).toBe("listen-history");
    await call("b1", "/sets/s1/tags", "PATCH", { tags: ["after"] });
    expect(await b1.nextTopic()).toBe("library");
    await call("c1", "/queue/completion", "POST", { setId: "s1" });
    expect(await c1.nextTopic()).toBe("listen-history");
    expect(await a1.nextTopic()).toBe("listen-history");
  } finally {
    await a1.close();
    await b1.close();
    await c1.close();
  }
}, 10_000);

test("an old client decoder reads the plain stream, and would reject a changed frame", async () => {
  const plain = await open("a1", "/events");
  const opted = await open("a1");
  try {
    await tagA("old");
    expect(await opted.nextTopic()).toBe("library");
    const kinds: string[] = [];
    // The plain stream opens with the Queue snapshot; a tag change adds nothing to it.
    await call("a2", "/queue/active", "PUT", { setId: "s1" });
    for (;;) {
      const raw = await plain.data();
      if (raw === null) {
        throw new Error("The event stream closed");
      }
      const event = decodeOld(raw);
      kinds.push(event.kind);
      if (event.kind === "queue" && event.queue.activeSetId === "s1") {
        break;
      }
    }
    expect(kinds).not.toContain("changed");
    expect(() =>
      decodeOld(JSON.stringify({ kind: "changed", topic: "library" }))
    ).toThrow();
  } finally {
    await plain.close();
    await opted.close();
  }
}, 10_000);

test("revoking a key closes its open stream", async () => {
  const a2 = await open("a2", "/events");
  await a2.data();
  const startedAt = Date.now();
  await call("a1", "/me/devices/a2", "DELETE");
  for (;;) {
    const raw = await a2.data();
    if (raw === null) {
      break;
    }
  }
  expect(Date.now() - startedAt).toBeLessThan(1500);
}, 10_000);
