import { Database as BunDatabase } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import { createApp } from "../../server/src/app.js";
import { layer } from "../../server/src/db/database.js";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-group",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "worker.ts")],
  external: ["cloudflare:workers"],
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
  compatibilityDate: "2026-07-30",
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
  assert.equal(unavailable.status, 404);
  const schemaResponse = await runtime.dispatchFetch(
    "http://orbis/api/__schema"
  );
  const schema = await schemaResponse.json();
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
  const app = createApp({
    database: layer({
      databasePath,
      migrationsFolder: path.resolve(import.meta.dir, "../../server/drizzle"),
    }),
  });
  try {
    const saved = await app.handler(
      new Request("http://localhost/sets", {
        body: JSON.stringify({
          tags: [],
          title: "Injected database",
          url: "https://youtu.be/abcdefghijk",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    assert.equal(saved.status, 201, await saved.clone().text());
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
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        health: "ok",
        injectedDatabaseUsed: true,
        persistsAcrossRestart: true,
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
