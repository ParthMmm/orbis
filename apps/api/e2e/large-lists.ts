import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { Miniflare } from "miniflare";

// The Group's SQLite binds at most 100 values in one statement. 40 Sets is more than one
// insert can hold for a playlist (3 values a row) or a queue (4 values a row).
const SET_COUNT = 40;

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-large-lists",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const Playlist = Schema.Struct({ id: Schema.String });
const PlaylistSets = Schema.Struct({ sets: Schema.Array(Schema.Unknown) });
const Queue = Schema.Struct({
  queue: Schema.Struct({ entries: Schema.Array(Schema.Unknown) }),
});
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "tracklist-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ef".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
const call = async (route: string, method = "GET", body?: string) => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body,
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer listener-token",
      "content-type": "application/json",
    },
    method,
  });
  const text = await response.text();
  assert.ok(
    response.ok,
    `${method} ${route} answered ${response.status}: ${text}`
  );
  if (!text.startsWith("{")) {
    return text;
  }
  const parsed: unknown = JSON.parse(text);
  return parsed;
};
try {
  await call("/__seed-tracklist");
  await call("/__seed-library");
  const setIds = Array.from(
    { length: SET_COUNT },
    (_, index) => `library-set-${index}`
  );
  const playlist = Schema.decodeUnknownSync(Playlist)(
    await call("/playlists", "POST", JSON.stringify({ name: "Long playlist" }))
  );
  await call(
    `/playlists/${playlist.id}/sets`,
    "PUT",
    JSON.stringify({ setIds })
  );
  const stored = Schema.decodeUnknownSync(PlaylistSets)(
    await call(`/playlists/${playlist.id}`)
  );
  assert.equal(stored.sets.length, SET_COUNT);
  await call(
    "/queue/playlist",
    "PUT",
    JSON.stringify({ playlistId: playlist.id })
  );
  const queue = Schema.decodeUnknownSync(Queue)(await call("/queue"));
  assert.equal(queue.queue.entries.length, SET_COUNT);
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        playlistSets: stored.sets.length,
        queueEntries: queue.queue.entries.length,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Large list journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
}
