/* oxlint-disable no-await-in-loop -- Ordered HTTP requests define the journey. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PresenceAction } from "@orbis/contracts";
import { PresenceActionResultSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";
import { Miniflare } from "miniflare";

const LEASE_MS = 30_000;
const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-presence",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "presence-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const options = {
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "cd".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
};
let runtime = new Miniflare(options);
const transcript: unknown[] = [];
const Snapshot = Schema.Struct({
  alarm: Schema.NullOr(Schema.Number),
  sessions: Schema.Array(
    Schema.Struct({
      action_number: Schema.Number,
      key_id: Schema.String,
      lease_expires_at: Schema.NullOr(Schema.Number),
      owner_generation: Schema.Number,
      session_id: Schema.String,
      state: Schema.String,
      updated_at: Schema.Number,
    })
  ),
});
type Body = { setId: string } | PresenceAction;
const call = async (route: string, method = "GET", body?: Body) => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer player-token",
      "content-type": "application/json",
    },
    method,
  });
  const text = await response.text();
  transcript.push({
    at: new Date().toISOString(),
    body,
    method,
    response: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
    route,
    status: response.status,
  });
  return { status: response.status, text };
};
const snapshot = async () => {
  const response = await call("/__presence");
  assert.equal(response.status, 200, response.text);
  return Schema.decodeUnknownSync(Snapshot)(JSON.parse(response.text));
};
try {
  const seeded = await call("/__seed-presence");
  assert.equal(seeded.status, 200);
  const activated = await call("/queue/active", "PUT", {
    setId: "presence-set",
  });
  assert.equal(activated.status, 200, activated.text);
  const playedAt = Date.now();
  const played = await call("/presence/actions", "POST", {
    actionId: "worker-play-1",
    actionNumber: 1,
    kind: "play",
    sessionId: "worker-session",
    setId: "presence-set",
  });
  assert.equal(played.status, 200, played.text);
  const result = Schema.decodeUnknownSync(PresenceActionResultSchema)(
    JSON.parse(played.text)
  );
  assert.equal(result.outcome, "accepted");
  assert.equal(result.session.state, "playing");
  if (result.session.state !== "playing") {
    throw new Error("unreachable");
  }
  const deadline = Date.parse(result.session.leaseExpiresAt);
  assert.ok(deadline - playedAt > LEASE_MS - 2000);
  assert.ok(deadline - playedAt <= LEASE_MS + 2000);

  const live = await snapshot();
  assert.equal(live.sessions.length, 1);
  assert.equal(live.sessions[0]?.state, "playing");
  assert.equal(live.sessions[0]?.lease_expires_at, deadline);
  assert.equal(live.alarm, deadline);

  await runtime.dispose();
  const evictedAt = Date.now();
  runtime = new Miniflare(options);
  const restored = await snapshot();
  assert.equal(restored.sessions[0]?.state, "playing");
  assert.equal(restored.sessions[0]?.lease_expires_at, deadline);
  assert.equal(restored.alarm, deadline);

  await Bun.sleep(Math.max(deadline - Date.now(), 0) + 5000);
  const expired = await snapshot();
  assert.equal(expired.sessions[0]?.state, "paused");
  assert.equal(expired.sessions[0]?.lease_expires_at, null);
  assert.equal(expired.alarm, null);
  const expiredAt = expired.sessions[0]?.updated_at ?? 0;
  assert.ok(
    expiredAt >= deadline,
    `expired at ${expiredAt} before ${deadline}`
  );
  assert.ok(
    expiredAt - deadline < 4000,
    `the alarm ran ${expiredAt - deadline} ms after the deadline`
  );

  const renew = await call("/presence/actions", "POST", {
    actionId: "worker-renew-2",
    actionNumber: 2,
    kind: "renew",
    ownerGeneration: result.session.ownerGeneration,
    sessionId: "worker-session",
  });
  assert.equal(renew.status, 409, renew.text);
  assert.equal(JSON.parse(renew.text).reason, "stale");
  const resumed = await call("/presence/actions", "POST", {
    actionId: "worker-play-3",
    actionNumber: 3,
    kind: "play",
    sessionId: "worker-session",
    setId: "presence-set",
  });
  assert.equal(resumed.status, 200, resumed.text);
  const resumedResult = Schema.decodeUnknownSync(PresenceActionResultSchema)(
    JSON.parse(resumed.text)
  );
  assert.ok(
    resumedResult.session.ownerGeneration > result.session.ownerGeneration
  );
  const stopped = await call("/presence/actions", "POST", {
    actionId: "worker-stop-4",
    actionNumber: 4,
    kind: "stop",
    ownerGeneration: resumedResult.session.ownerGeneration,
    sessionId: "worker-session",
  });
  assert.equal(stopped.status, 200, stopped.text);
  const final = await snapshot();
  assert.equal(final.sessions[0]?.state, "stopped");
  assert.equal(final.alarm, null);

  await writeFile(
    path.join(artifact, "transcript.json"),
    `${JSON.stringify(transcript, null, 2)}\n`
  );
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        alarmRanAfterDeadlineMs: expiredAt - deadline,
        evictedBeforeDeadlineMs: deadline - evictedAt,
        expiredWithoutPoll: true,
        leaseDeadline: new Date(deadline).toISOString(),
        leaseSurvivedEviction: true,
        resumedAfterExpiry: true,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Presence lease journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
}
