/* oxlint-disable no-await-in-loop -- Polling the Group defines the journey. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { Miniflare } from "miniflare";

// Versos answers a Tracklist request in seconds, long after the Group has answered the retry
// that started it. A run that only lives as long as that request never stores its Cues.
const READY_AFTER_MS = 3000;
const CUES = [
  {
    appleMusicId: null,
    artist: "Artist",
    artworkUrl: null,
    position: 0,
    startSeconds: 0,
    title: "Opening track",
  },
];

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-tracklists",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const TracklistRequest = Schema.Struct({ url: Schema.String });
const Tracklist = Schema.Struct({
  cues: Schema.Array(Schema.Unknown),
  state: Schema.String,
});
const requestedAt = new Map<string, number>();
const calls: string[] = [];
const versos = Bun.serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    calls.push(`${Date.now()} ${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/orbis/tracklists") {
      const body = Schema.decodeUnknownSync(TracklistRequest)(
        await request.json()
      );
      requestedAt.set(body.url, Date.now());
      return Response.json({ requestId: body.url });
    }
    const requestId = decodeURIComponent(
      url.pathname.replace("/orbis/tracklists/", "")
    );
    const started = requestedAt.get(requestId);
    if (started === undefined) {
      return new Response("unknown request", { status: 404 });
    }
    return Response.json(
      Date.now() - started < READY_AFTER_MS
        ? { state: "pending" }
        : { cues: CUES, state: "ready" }
    );
  },
  port: 0,
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
    VERSOS_API_KEY: "versos-key",
    VERSOS_URL: versos.url.toString(),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
const call = async (route: string, method = "GET") => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer listener-token",
    },
    method,
  });
  return { status: response.status, text: await response.text() };
};
const waitForReady = async (id: string) => {
  const deadline = Date.now() + READY_AFTER_MS + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const tracklist = await call(`/sets/${id}/tracklist`);
    assert.equal(tracklist.status, 200, tracklist.text);
    last = tracklist.text;
    const answer = Schema.decodeUnknownSync(Tracklist)(JSON.parse(last));
    if (answer.state === "ready") {
      return answer;
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `${id} never became ready; last answer ${last}; Versos saw ${calls.join(", ")}`
  );
};
try {
  const seeded = await call("/__seed-tracklist");
  assert.equal(seeded.status, 200, seeded.text);
  const startedAt = Date.now();
  const retried = await call("/sets/slow-set/tracklist/retry", "POST");
  assert.equal(retried.status, 200, retried.text);
  const ready = await waitForReady("slow-set");
  assert.equal(ready.cues.length, CUES.length);
  // A second Set started after the first run finished proves the Group still takes new runs.
  const second = await call("/sets/second-set/tracklist/retry", "POST");
  assert.equal(second.status, 200, second.text);
  await waitForReady("second-set");
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        readyAfterMs: Date.now() - startedAt,
        setsReady: ["slow-set", "second-set"],
        versosAnsweredAfterMs: READY_AFTER_MS,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Tracklist journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
  await versos.stop(true);
}
