import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer } from "effect";

import { createApp } from "../../server/src/app.js";
import { layer } from "../../server/src/db/database.js";
import {
  exportDatabase,
  importDatabase,
  parseDump,
  tableChecksums,
} from "../../server/src/sql-transfer.js";

// Failures: omitted trust/migration tables, lost row order or values, partial import,
// repeat import, altered SQL, restored database migration failure, changed HTTP readback.
const artifact = path.resolve(
  process.env.ORBIS_TRANSFER_ARTIFACT ??
    `.cache/data-transfer/${crypto.randomUUID()}`
);
await mkdir(artifact, { mode: 0o700, recursive: true });
const sourcePath = process.env.ORBIS_TRANSFER_SOURCE;
assert.ok(
  sourcePath,
  "Set ORBIS_TRANSFER_SOURCE to a private migrated SQLite copy."
);
const source = new Database(sourcePath, { readonly: true });
const adapter = (db: Database) => ({
  execute: (
    sql: string,
    bindings: readonly (string | number | null)[] = []
  ) => {
    db.run(sql, [...bindings]);
  },
  query: (sql: string, bindings: readonly (string | number | null)[] = []) =>
    db.query(sql).all(...bindings),
});
try {
  const dump = exportDatabase(adapter(source));
  await writeFile(path.join(artifact, "source.sql"), dump, { mode: 0o600 });
  const manifest = parseDump(dump);
  assert.ok(manifest.tables.some((t) => t.name === "api_keys"));
  assert.ok(manifest.tables.some((t) => t.name === "__drizzle_migrations"));
  const restoredPath = path.join(artifact, "library.sqlite");
  const restored = new Database(restoredPath, { create: true });
  try {
    restored.exec(dump);
    assert.ok(
      exportDatabase(adapter(restored)) === dump,
      "Restored SQL differs from source."
    );
    assert.throws(() => parseDump(`${dump}DELETE FROM people;`));
    assert.throws(() =>
      restored.transaction(() => importDatabase(adapter(restored), manifest))()
    );
  } finally {
    restored.close();
  }
  const app = createApp({
    database: layer({
      databasePath: restoredPath,
      migrationsFolder: path.resolve("apps/server/drizzle"),
    }),
  });
  try {
    const response = await app.handler(new Request("http://localhost/sets"));
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    await app.dispose();
  }
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        layer({
          databasePath: restoredPath,
          migrationsFolder: path.resolve("apps/server/drizzle"),
        })
      )
    )
  );
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify(
      {
        alteredSqlRefused: true,
        repeatImportRefused: true,
        restoredDatabaseStarts: true,
        source: await tableChecksums(manifest),
      },
      null,
      2
    )
  );
  console.log(path.join(artifact, "result.json"));
} finally {
  source.close();
}
