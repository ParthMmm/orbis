import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { Miniflare } from "miniflare";

import { createPortableApp } from "../../server/src/app-core.js";
import { layer } from "../../server/src/db/database.js";
import { hashToken } from "../../server/src/identity.js";
import {
  exportDatabase,
  parseDump,
  renderDump,
  tableChecksums,
} from "../../server/src/sql-transfer.js";
import { audioLayer } from "../src/audio.js";

const sourcePath = process.env.ORBIS_TRANSFER_SOURCE;
const token = process.env.ORBIS_NODE_KEY;
const hostToken = process.env.ORBIS_TRANSFER_HOST_KEY;
assert.ok(sourcePath, "Set ORBIS_TRANSFER_SOURCE to a private migrated copy.");
assert.ok(token, "Set ORBIS_NODE_KEY to a key minted in the private copy.");
assert.ok(
  hostToken,
  "Set ORBIS_TRANSFER_HOST_KEY to a Host key minted in the private copy."
);
const artifact = path.resolve(`.cache/transfer-group/${crypto.randomUUID()}`);
await mkdir(artifact, { mode: 0o700, recursive: true });
const adapter = (db: Database) => ({
  execute: (sql: string) => {
    db.run(sql);
  },
  query: (sql: string) => db.query(sql).all(),
});
const source = new Database(sourcePath, { readonly: true });
const dump = source.transaction(() => exportDatabase(adapter(source)))();
const IdRows = Schema.Array(Schema.Struct({ id: Schema.String }));
const setIds = Schema.decodeUnknownSync(IdRows)(
  source
    .query(
      "SELECT set_id AS id FROM library_entries WHERE person_id = 'host' ORDER BY set_id"
    )
    .all()
);
const playlistIds = Schema.decodeUnknownSync(IdRows)(
  source.query("SELECT id FROM playlists ORDER BY id").all()
);
source.close();
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "transfer-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.ok(bundle.success, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const options = {
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    IMPORT_NODE_KEY_DIGEST: hashToken(token),
    STREAM_GRANT_SECRET: "11".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
};
let runtime = new Miniflare(options);
const send = (route: string, body?: string, key = token) => {
  const init: RequestInit = {
    headers: { authorization: `Bearer ${key}` },
    method: body === undefined ? "GET" : "POST",
  };
  if (body !== undefined) {
    init.body = body;
  }
  return runtime.dispatchFetch(`http://orbis/api/${route}`, init);
};
const runCli = async (arguments_: readonly string[], expectedExit = 0) => {
  const child = Bun.spawn(
    [process.execPath, path.resolve("scripts/data-transfer.ts"), ...arguments_],
    {
      env: { ...process.env, ORBIS_NODE_KEY: token },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const cliOutput = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  assert.equal(await child.exited, expectedExit, errors);
  return cliOutput;
};
const localApp = (databasePath: string) =>
  createPortableApp({
    audio: audioLayer,
    database: layer({
      databasePath,
      migrationsFolder: path.resolve("apps/server/drizzle"),
    }),
    logging: { silent: true },
    streamSecret: Buffer.from("11".repeat(32), "hex"),
  });
try {
  const deniedExport = await send("export");
  assert.equal(deniedExport.status, 401);
  const deniedImport = await send("import", "", "wrong");
  assert.equal(deniedImport.status, 401);
  const malformed = await send("import", `${dump}DELETE FROM people;`);
  assert.equal(malformed.status, 400);
  const cliSource = path.join(artifact, "source.sql");
  await runCli(["export", sourcePath, cliSource]);
  assert.ok(
    (await Bun.file(cliSource).text()) === dump,
    "CLI export differs from source."
  );
  const manifest = parseDump(dump);
  const invalid = {
    ...manifest,
    tables: manifest.tables.map((table) =>
      table.name === "api_keys"
        ? { ...table, rows: [...table.rows, ...table.rows.slice(0, 1)] }
        : table
    ),
  };
  const constraintFailure = await send("import", renderDump(invalid));
  assert.equal(constraintFailure.status, 400);
  const imported = await send("import", dump);
  assert.equal(imported.status, 200, await imported.clone().text());
  const checksums = await tableChecksums(manifest);
  assert.deepEqual(await imported.json(), checksums);
  const repeated = await send("import", dump);
  assert.equal(repeated.status, 409);
  const exported = await send("export");
  assert.equal(exported.status, 200, await exported.clone().text());
  const sql = await exported.text();
  assert.deepEqual(await tableChecksums(parseDump(sql)), checksums);
  await writeFile(path.join(artifact, "group.sql"), sql, { mode: 0o600 });
  const restoredPath = path.join(artifact, "library.sqlite");
  const groupSql = path.join(artifact, "group.sql");
  await runCli(["restore", groupSql, restoredPath]);
  await runCli(["restore", groupSql, restoredPath], 1);
  const runtimeUrl = await runtime.ready;
  const apiUrl = `${runtimeUrl.origin}/api`;
  await runCli(["import", cliSource, apiUrl], 1);
  const cliRuntime = new Miniflare({
    ...options,
    durableObjectsPersist: path.join(artifact, "cli-storage"),
  });
  try {
    const cliUrl = await cliRuntime.ready;
    const confirmation = await runCli([
      "import",
      cliSource,
      `${cliUrl.origin}/api`,
    ]);
    assert.ok(confirmation.includes("Every table count and checksum matches."));
  } finally {
    await cliRuntime.dispose();
  }
  const backups = path.join(artifact, "backups");
  await runCli(["backup", apiUrl, backups]);
  const backedUp = await Array.fromAsync(new Bun.Glob("*.sql").scan(backups));
  assert.equal(backedUp.length, 1);
  assert.ok(
    (await Bun.file(path.join(backups, backedUp[0] ?? "missing")).text()) ===
      sql,
    "CLI backup differs from Group export."
  );
  const restored = new Database(restoredPath, { readonly: true });
  try {
    assert.deepEqual(
      await tableChecksums(parseDump(exportDatabase(adapter(restored)))),
      checksums
    );
  } finally {
    restored.close();
  }
  await runtime.dispose();
  runtime = new Miniflare({
    ...options,
    bindings: {
      ...options.bindings,
      IMPORT_NODE_KEY_DIGEST: hashToken("different-bootstrap"),
    },
  });
  const restarted = await send("export");
  assert.equal(restarted.status, 200);
  assert.deepEqual(
    await tableChecksums(parseDump(await restarted.text())),
    checksums
  );
  const sourceApp = localApp(sourcePath);
  const restoredApp = localApp(restoredPath);
  const routes = [
    "/sets",
    "/playlists",
    "/queue",
    ...setIds.map(({ id }) => `/sets/${id}/tracklist`),
    ...playlistIds.map(({ id }) => `/playlists/${id}`),
  ];
  try {
    // oxlint-disable eslint/no-await-in-loop -- Each journey checks all three databases before advancing.
    for (const route of routes) {
      const original = await sourceApp.handler(
        new Request(`http://localhost${route}`),
        "local"
      );
      const group = await send(route.slice(1), undefined, hostToken);
      const bun = await restoredApp.handler(
        new Request(`http://localhost${route}`),
        "local"
      );
      assert.equal(original.status, 200, `Source ${route}`);
      assert.equal(group.status, 200, `Group ${route}`);
      assert.equal(bun.status, 200, `Restored ${route}`);
      const expected = await original.text();
      assert.ok(
        (await group.text()) === expected,
        `Group readback differs at ${route}`
      );
      assert.ok(
        (await bun.text()) === expected,
        `Restored readback differs at ${route}`
      );
    }
    // oxlint-enable eslint/no-await-in-loop
  } finally {
    await sourceApp.dispose();
    await restoredApp.dispose();
  }
  const ordinary = await send("sets");
  assert.equal(ordinary.status, 403);
  const dailyExport = await send("export", undefined, hostToken);
  assert.equal(dailyExport.status, 403);
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify(
      {
        badKeyRefused: true,
        bootstrapExportRefused: true,
        bootstrapIgnoredAfterImport: true,
        checksums,
        cliBackupMatches: true,
        cliExportMatches: true,
        cliImportVerified: true,
        cliRestoreVerified: true,
        constraintFailureAtomic: true,
        groupExportMatches: true,
        hostReadbackRoutes: routes,
        malformedImportRefused: true,
        nodeScopeRestricted: true,
        repeatImportRefused: true,
        restoredDatabaseStarts: true,
      },
      null,
      2
    )
  );
  console.log(path.join(artifact, "result.json"));
} finally {
  await runtime.dispose();
}
