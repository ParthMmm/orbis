import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Miniflare } from "miniflare";

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
const output = bundle.outputs[0];
assert.ok(output);
const secret = Buffer.from("ab".repeat(32), "hex");
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: secret.toString("hex"),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
try {
  assert.equal(
    (await runtime.dispatchFetch("http://orbis/api/__seed")).status,
    200
  );
  const savedResponse = await runtime.dispatchFetch("http://orbis/api/sets", {
    body: JSON.stringify({
      title: "Grant fixture",
      tags: [],
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
  assert.equal(
    (await runtime.dispatchFetch("http://orbis/api/__ready")).status,
    200
  );
  const grant = issueStreamGrant(secret, saved.id, "host");
  const audio = (value: string, authorization?: string) =>
    runtime.dispatchFetch(
      `http://orbis/api/sets/${saved.id}/audio?grant=${encodeURIComponent(value)}`,
      { headers: authorization ? { authorization } : {}, redirect: "manual" }
    );
  const response = await audio(grant, "Bearer invalid-key");
  assert.equal(response.status, 302, await response.clone().text());
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://audio.example");
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
  for (const invalid of [
    grant.slice(0, -1) + (grant.endsWith("0") ? "1" : "0"),
    issueStreamGrant(secret, "wrong-set", "host"),
    `1000000000000.host.${"a".repeat(64)}`,
  ]) {
    // Each request checks that a valid key cannot repair an invalid grant.
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await audio(invalid, "Bearer smoke-token")).status, 401);
  }
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        grantPrecedence: true,
        expiryPreserved: true,
        invalidGrantRejected: true,
        bearerRedirect: true,
      },
      null,
      2
    )
  );
  console.log(`Grant artifact: ${artifact}`);
} finally {
  await runtime.dispose();
}
