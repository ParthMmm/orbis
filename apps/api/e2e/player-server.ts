import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { Miniflare } from "miniflare";

import { makeNodeAudioHandler } from "../../server/src/node-audio-http.js";

const directory = process.env.ORBIS_DATA_DIR;
assert.ok(directory, "ORBIS_DATA_DIR is required");
const fixture = path.resolve(
  import.meta.dir,
  "../../../scripts/fixtures/ready-set.m4a"
);
const audioDir = path.join(directory, "audio");
await mkdir(audioDir, { recursive: true });
const secret = Buffer.from("ab".repeat(32), "hex");
const audioHandler = makeNodeAudioHandler({ audioDir, streamSecret: secret });
const audio = Bun.serve({
  fetch: audioHandler,
  hostname: "127.0.0.1",
  port: Number(process.env.ORBIS_AUDIO_PORT ?? 0),
});
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "player-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
assert.ok(bundle.outputs[0]);
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: audio.url.origin,
    STREAM_GRANT_SECRET: secret.toString("hex"),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(directory, "group"),
  modules: true,
  script: await bundle.outputs[0].text(),
});
const seeded = await runtime.dispatchFetch("http://group/api/__seed");
assert.equal(seeded.status, 200);
const api = Bun.serve({
  fetch: async (request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-headers": "authorization, content-type, range",
          "access-control-allow-methods":
            "GET, POST, PATCH, PUT, DELETE, OPTIONS",
          "access-control-allow-origin": request.headers.get("origin") ?? "",
        },
        status: 204,
      });
    }
    const url = new URL(request.url);
    const seed =
      /^\/(?<action>ready-audio|tracklist)\/(?<id>[a-zA-Z0-9-]+)$/u.exec(
        url.pathname
      );
    if (seed?.groups && request.method === "POST") {
      if (seed.groups.action === "ready-audio") {
        await copyFile(fixture, path.join(audioDir, `${seed.groups.id}.m4a`));
      }
      url.pathname = `/api/__journey/${seed.groups.action}/${seed.groups.id}`;
      url.searchParams.set("bytes", String(Bun.file(fixture).size));
    } else {
      url.pathname = `/api${url.pathname}`;
    }
    const headers = new Headers(request.headers);
    const origin = headers.get("origin");
    headers.delete("origin");
    const response = await runtime.dispatchFetch(url.toString(), {
      body: request.body,
      headers,
      method: request.method,
      redirect: "manual",
    });
    if (origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set(
        "access-control-allow-headers",
        "authorization, content-type, range"
      );
      response.headers.set(
        "access-control-allow-methods",
        "GET, POST, PATCH, PUT, DELETE, OPTIONS"
      );
    }
    return response;
  },
  hostname: "127.0.0.1",
  idleTimeout: 60,
  port: Number(process.env.ORBIS_PORT ?? 0),
});
console.log(
  JSON.stringify({
    api: api.url.origin,
    audio: audio.url.origin,
    token: "smoke-token",
  })
);
process.on("SIGTERM", async () => {
  await api.stop(true);
  await audio.stop(true);
  await runtime.dispose();
  process.exit(0);
});
