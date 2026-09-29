/* oxlint-disable no-await-in-loop -- SSE frames and ordered client actions are observed in sequence. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ListeningQueueSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { revokeKey } from "./admin.js";
import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { startListeners } from "./listeners.js";

const Event = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queue"), queue: ListeningQueueSchema }),
  Schema.Struct({ kind: Schema.Literal("heartbeat") }),
]);
const frames = (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("The event response has no stream");
  }
  const decoder = new TextDecoder();
  let pending = "";
  return {
    close: () => reader.cancel(),
    next: async () => {
      while (!pending.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("The event stream closed");
        }
        pending += decoder.decode(chunk.value, { stream: true });
      }
      const boundary = pending.indexOf("\n\n");
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return Schema.decodeUnknownSync(Schema.fromJsonString(Event))(data);
    },
  };
};

test("live Queue snapshots stay personal and reconnect to current state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-events-"));
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["a1", "a2", "b1"].map((id) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: id[0],
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        username: id,
      })),
      version: 2,
    })
  );
  const listeners = await startListeners(
    createApp({ databasePath, logging: { silent: true } }),
    { devicePort: 0, localPort: 0 }
  );
  const address = listeners.device?.url;
  if (!address) {
    throw new Error("Device listener missing");
  }
  const call = (
    key: string,
    route: string,
    method = "GET",
    payload?:
      | { title: string; url: string }
      | { name: string }
      | { setIds: string[] }
      | { playlistId: string }
      | { setId: string }
  ) => {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method,
    };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    return fetch(new URL(route, address), init);
  };
  const opened: ReturnType<typeof frames>[] = [];
  try {
    const unpaired = await fetch(new URL("/events", address));
    expect(unpaired.status).toBe(403);
    const streamA = await call("a1", "/events");
    expect(streamA.status).toBe(200);
    expect(streamA.headers.get("content-type")).toContain("text/event-stream");
    expect(streamA.headers.get("cache-control")).toContain("no-cache");
    const a = frames(streamA);
    opened.push(a);
    const b = frames(await call("b1", "/events"));
    opened.push(b);
    expect(await a.next()).toEqual({
      kind: "queue",
      queue: { activeSetId: null, entries: [] },
    });
    expect(await b.next()).toEqual({
      kind: "queue",
      queue: { activeSetId: null, entries: [] },
    });
    const saved = await call("a2", "/sets", "POST", {
      title: "Remote playlist Set",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    expect(saved.status).toBe(201);
    const set = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await saved.json()
    );
    const db = new Database(databasePath);
    db.run(
      "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = 100 WHERE id = ?",
      [set.id]
    );
    db.close();
    const playlistResponse = await call("a2", "/playlists", "POST", {
      name: "Remote picks",
    });
    const playlist = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String })
    )(await playlistResponse.json());
    const members = await call("a2", `/playlists/${playlist.id}/sets`, "PUT", {
      setIds: [set.id],
    });
    expect(members.status).toBe(200);
    const startedAt = Date.now();
    const start = await call("a2", "/queue/playlist", "PUT", {
      playlistId: playlist.id,
    });
    expect(start.status).toBe(200);
    const changed = await a.next();
    expect(changed.kind).toBe("queue");
    if (changed.kind !== "queue") {
      throw new Error("Expected Queue snapshot");
    }
    expect(changed.queue.activeSetId).toBe(set.id);
    expect(changed.queue.entries.map((entry) => entry.id)).toEqual([set.id]);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    const peer = frames(await call("a2", "/events"));
    opened.push(peer);
    expect(await peer.next()).toEqual(changed);
    const bNext = b.next();
    bNext.catch(() => null);
    const quiet = await Promise.race([
      bNext.then(() => false),
      Bun.sleep(150).then(() => true),
    ]);
    expect(quiet).toBe(true);
    await a.close();
    const reconnected = frames(await call("a1", "/events"));
    opened.push(reconnected);
    expect(await reconnected.next()).toEqual(changed);
    const finish = await call("a2", "/queue/completion", "POST", {
      setId: set.id,
    });
    expect(finish.status).toBe(200);
    const completed = await reconnected.next();
    expect(completed).toEqual({
      kind: "queue",
      queue: { activeSetId: null, entries: [] },
    });
    expect(await peer.next()).toEqual(completed);
    revokeKey(path.join(root, "devices.json"), "a1");
    const replay = await call("a2", "/queue/active", "PUT", { setId: set.id });
    expect(replay.status).toBe(200);
    await expect(reconnected.next()).rejects.toThrow("The event stream closed");
    await mkdir(path.resolve(import.meta.dir, "../../../.cache/queue-events"), {
      recursive: true,
    });
    await writeFile(
      path.resolve(import.meta.dir, "../../../.cache/queue-events/http.json"),
      JSON.stringify({ changed, completed, otherPersonQuiet: quiet }, null, 2)
    );
    bNext.catch(() => null);
  } finally {
    await Promise.all(opened.map((stream) => stream.close().catch(() => null)));
    await listeners.stop();
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);
