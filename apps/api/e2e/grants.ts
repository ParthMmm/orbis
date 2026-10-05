import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Miniflare } from "miniflare";

import { makeNodeHttpHandler } from "../../server/src/node-http.js";
import { issueStreamGrant } from "../../server/src/stream-grant-core.js";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-grants",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const secret = Buffer.from("ab".repeat(32), "hex");
const groupUrl = new URL("http://127.0.0.1:0/api");
const audioDirectory = path.join(artifact, "audio");
const node = Bun.serve({
  fetch: makeNodeHttpHandler({
    apiUrl: groupUrl,
    audioDir: audioDirectory,
    streamSecret: secret,
  }),
  hostname: "127.0.0.1",
  port: 0,
});
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: node.url.origin,
    STREAM_GRANT_SECRET: secret.toString("hex"),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
const upstream = Bun.serve({
  fetch: (request) =>
    runtime.dispatchFetch(new Request(request, { redirect: "manual" })),
  hostname: "127.0.0.1",
  port: 0,
});
groupUrl.host = upstream.url.host;
try {
  const seeded = await runtime.dispatchFetch("http://orbis/api/__seed");
  assert.equal(seeded.status, 200);
  const savedResponse = await runtime.dispatchFetch("http://orbis/api/sets", {
    body: JSON.stringify({
      tags: [],
      title: "Grant fixture",
      url: "https://youtu.be/abcdefghijk",
    }),
    headers: {
      authorization: "Bearer smoke-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  await mkdir(audioDirectory);
  await Bun.write(
    path.join(audioDirectory, `${saved.id}.m4a`),
    Bun.file(
      path.resolve(import.meta.dir, "../../../scripts/fixtures/ready-set.m4a")
    )
  );
  const ready = await runtime.dispatchFetch("http://orbis/api/__ready");
  assert.equal(ready.status, 200);
  const grant = issueStreamGrant(secret, saved.id, "host");
  const audio = (value: string, authorization?: string) =>
    runtime.dispatchFetch(
      `http://orbis/api/sets/${saved.id}/audio?grant=${encodeURIComponent(value)}`,
      { headers: authorization ? { authorization } : {}, redirect: "manual" }
    );
  const response = await audio(grant, "Bearer invalid-key");
  assert.equal(response.status, 302, await response.clone().text());
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, node.url.origin);
  assert.equal(location.searchParams.get("grant"), grant);
  const keyed = await runtime.dispatchFetch(
    `http://orbis/api/sets/${saved.id}/audio`,
    {
      headers: { authorization: "Bearer smoke-token", range: "bytes=0-127" },
      redirect: "manual",
    }
  );
  assert.equal(keyed.status, 302);
  const invisible = await runtime.dispatchFetch(
    `http://orbis/api/sets/${saved.id}/audio`,
    {
      headers: { authorization: "Bearer outsider-token" },
      redirect: "manual",
    }
  );
  assert.equal(invisible.status, 404);
  const legacyAudioUrl = new URL(`api/sets/${saved.id}/audio`, node.url);
  const legacy = await fetch(legacyAudioUrl, {
    headers: { authorization: "Bearer smoke-token", range: "bytes=0-127" },
    redirect: "manual",
  });
  assert.equal(
    legacy.status,
    302,
    "The old Funnel must authorize Bearer-only audio through the Group."
  );
  const legacyLocation = new URL(legacy.headers.get("location") ?? "");
  assert.equal(legacyLocation.origin, node.url.origin);
  const ranged = await fetch(legacyLocation, {
    headers: { range: "bytes=0-127" },
  });
  assert.equal(ranged.status, 206);
  const rangedBytes = await ranged.arrayBuffer();
  assert.equal(rangedBytes.byteLength, 128);
  const legacyInvisible = await fetch(legacyAudioUrl, {
    headers: { authorization: "Bearer outsider-token" },
    redirect: "manual",
  });
  assert.equal(legacyInvisible.status, 404);
  legacyAudioUrl.searchParams.set("grant", "invalid");
  const legacyInvalidGrant = await fetch(legacyAudioUrl, {
    headers: { authorization: "Bearer smoke-token" },
    redirect: "manual",
  });
  assert.equal(legacyInvalidGrant.status, 401);
  for (const invalid of [
    grant.slice(0, -1) + (grant.endsWith("0") ? "1" : "0"),
    issueStreamGrant(secret, "wrong-set", "host"),
    `1000000000000.host.${"a".repeat(64)}`,
  ]) {
    // Each request checks that a valid key cannot repair an invalid grant.
    // eslint-disable-next-line no-await-in-loop
    const rejected = await audio(invalid, "Bearer smoke-token");
    assert.equal(rejected.status, 401);
  }
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify(
      {
        bearerRedirect: true,
        expiryPreserved: true,
        grantPrecedence: true,
        invalidGrantRejected: true,
        legacyFunnelBearerRedirect: true,
        legacyFunnelGrantPrecedence: true,
        legacyFunnelRange: true,
        status: "passed",
      },
      null,
      2
    )
  );
  console.log(`Grant artifact: ${artifact}`);
} finally {
  await node.stop(true);
  await upstream.stop(true);
  await runtime.dispose();
}
