import { Database as BunDatabase } from "bun:sqlite";

import "../../server/src/trust-storage-bun.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Miniflare } from "miniflare";

import { createPortableApp } from "../../server/src/app-core.js";
import { releaseAudio } from "../../server/src/audio-release.js";
import { layer } from "../../server/src/db/database.js";
import { hashToken } from "../../server/src/identity.js";
import { audioLayer } from "../src/audio.js";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-group",
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
const script = await output.text();
const production = await readFile(
  path.join(import.meta.dir, "../dist/index.js"),
  "utf-8"
);
assert.doesNotMatch(production, /bun:sqlite|node:fs|Bun\.|yt-dlp|cobalt/u);
const options = {
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script,
};
let runtime = new Miniflare(options);
try {
  const health = await runtime.dispatchFetch("http://orbis/api/health");
  assert.equal(health.status, 200, await health.clone().text());
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.ok(health.headers.get("x-smoke-group"));
  const second = await runtime.dispatchFetch("http://other/api/health");
  assert.equal(
    health.headers.get("x-smoke-group"),
    second.headers.get("x-smoke-group")
  );
  const unavailable = await runtime.dispatchFetch("http://orbis/api/sets");
  assert.equal(unavailable.status, 403);
  const schemaResponse = await runtime.dispatchFetch(
    "http://orbis/api/__schema"
  );
  const schema = await schemaResponse.json();
  const seeded = await runtime.dispatchFetch("http://orbis/api/__seed");
  assert.equal(seeded.status, 200);
  const call = (
    route: string,
    method = "GET",
    body?: Record<string, string | string[]>,
    token = "smoke-token"
  ) =>
    runtime.dispatchFetch(`http://orbis/api${route}`, {
      body: JSON.stringify(body),
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method,
      signal: AbortSignal.timeout(90_000),
    });
  const me = await call("/me");
  assert.equal(me.status, 200, await me.clone().text());
  const savedResponse = await call("/sets", "POST", {
    tags: [],
    title: "Group smoke",
    url: "https://youtu.be/abcdefghijk",
  });
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  assert.ok(saved.id);
  const playlistResponse = await call("/playlists", "POST", {
    name: "Group smoke playlist",
  });
  assert.equal(
    playlistResponse.status,
    201,
    await playlistResponse.clone().text()
  );
  const playlist = await playlistResponse.json();
  const edited = await call(`/playlists/${playlist.id}/sets`, "PUT", {
    setIds: [saved.id],
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const renamed = await call(`/playlists/${playlist.id}`, "PATCH", {
    name: "Edited in Group",
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const keyResponse = await call("/admin/people/host/keys", "POST", {
    label: "event reader",
    scope: "daily",
  });
  assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
  const eventKey = await keyResponse.json();
  const events = await call("/events", "GET", undefined, eventKey.token);
  assert.equal(events.status, 200);
  assert.ok(events.body);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /queue/u);
  const heartbeatDeadline = Date.now() + 40_000;
  let heartbeatSeen = false;
  while (Date.now() < heartbeatDeadline) {
    // A stream must be consumed in order.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    if (new TextDecoder().decode(chunk.value).includes('"heartbeat"')) {
      heartbeatSeen = true;
      break;
    }
  }
  assert.equal(heartbeatSeen, true);
  const revoked = await call(`/admin/keys/${eventKey.id}`, "DELETE");
  assert.equal(revoked.status, 200, await revoked.clone().text());
  let ended = false;
  const revocationDeadline = Date.now() + 35_000;
  while (Date.now() < revocationDeadline) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      break;
    }
  }
  assert.equal(ended, true);
  const revokedSignIn = await call("/me", "GET", undefined, eventKey.token);
  assert.equal(revokedSignIn.status, 401);
  await Promise.all(
    Array.from({ length: 21 }, () => call("/me", "GET", undefined, "bad-key"))
  );
  const limited = await call("/me", "GET", undefined, "bad-key");
  assert.equal(limited.status, 429);
  const differentAddress = await runtime.dispatchFetch("http://orbis/api/me", {
    headers: {
      "CF-Connecting-IP": "192.0.2.2",
      authorization: "Bearer bad-key",
    },
  });
  assert.equal(differentAddress.status, 401);
  const jobs = await runtime.dispatchFetch("http://orbis/api/__jobs");
  assert.deepEqual(await jobs.json(), [{ state: "queued" }]);
  const databasePath = path.join(artifact, "bun.sqlite");
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        layer({
          databasePath,
          migrationsFolder: path.resolve(
            import.meta.dir,
            "../../server/drizzle"
          ),
        })
      )
    )
  );
  const db = new BunDatabase(databasePath);
  const bunSchema = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all();
  db.close();
  assert.deepEqual(schema, bunSchema);
  const bunToken = "bun-parity-host-key";
  const trustPath = path.join(artifact, "bun-devices.json");
  await writeFile(
    trustPath,
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "bun-parity-key",
          label: "Bun parity",
          lastUsedAt: null,
          personId: "host",
          scope: "admin",
          tokenHash: hashToken(bunToken),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const app = createPortableApp({
    audio: audioLayer,
    audioResponse: () => HttpServerResponse.empty({ status: 404 }),
    database: layer({
      databasePath,
      migrationsFolder: path.resolve(import.meta.dir, "../../server/drizzle"),
    }),
    logging: { pretty: false, silent: true },
    releaseAudio,
    streamSecret: Buffer.from("ab".repeat(32), "hex"),
    trustPath,
  });
  try {
    const bunSaved = await app.handler(
      new Request("http://localhost/sets", {
        body: JSON.stringify({
          tags: [],
          title: "Injected database",
          url: "https://youtu.be/abcdefghijk",
        }),
        headers: {
          authorization: `Bearer ${bunToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    assert.equal(bunSaved.status, 201, await bunSaved.clone().text());
    const injected = new BunDatabase(databasePath, { readonly: true });
    assert.deepEqual(
      injected.query("SELECT title_override FROM library_entries").all(),
      [{ title_override: "Injected database" }]
    );
    injected.close();
  } finally {
    await app.dispose();
  }
  const written = await runtime.dispatchFetch("http://orbis/api/__write");
  assert.equal(written.status, 200);
  await runtime.dispose();
  runtime = new Miniflare(options);
  const restored = await runtime.dispatchFetch("http://orbis/api/__read");
  assert.deepEqual(await restored.json(), [{ value: "persisted" }]);
  const restoredSignIn = await call("/me");
  assert.equal(restoredSignIn.status, 200);
  const persistedSets = await call("/sets");
  assert.equal(persistedSets.status, 200, await persistedSets.clone().text());
  const restoredLibrary = await persistedSets.json();
  assert.equal(restoredLibrary.sets[0].id, saved.id);
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        authenticatedApi: true,
        downloadsQueued: true,
        editedPlaylist: playlist.id,
        events: true,
        health: "ok",
        heartbeat: true,
        injectedDatabaseUsed: true,
        persistsAcrossRestart: true,
        rateLimitByClientAddress: true,
        revokedStreamClosed: true,
        savedSet: saved.id,
        schema,
        schemaMatchesBun: true,
        singleton: true,
      },
      null,
      2
    )}\n`
  );
  console.log(`Group smoke passed. ${path.join(artifact, "result.json")}`);
} finally {
  await runtime.dispose();
}
