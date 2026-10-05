import "../../server/src/trust-storage-bun.js";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Schema } from "effect";

import { layer } from "../../server/src/db/database.js";
import {
  hashToken,
  migrateTrustStore,
  mutateTrustStore,
  readTrustStrict,
} from "../../server/src/identity.js";

const [sourceDirectory] = process.argv.slice(2);
assert.ok(
  sourceDirectory,
  "Usage: bun apps/api/e2e/transfer-verify.ts <source data directory>"
);
const artifact = path.resolve(
  `.cache/transfer-verification/${crypto.randomUUID()}`
);
await mkdir(artifact, { mode: 0o700, recursive: true });
const privateDirectory = path.join(artifact, "source");
await mkdir(privateDirectory, { mode: 0o700 });
const databasePath = path.join(privateDirectory, "library.sqlite");
const live = new Database(path.join(sourceDirectory, "library.sqlite"), {
  readonly: true,
});
try {
  live.run("VACUUM INTO ?", [databasePath]);
} finally {
  live.close();
}
await chmod(databasePath, 0o600);
const legacy = path.join(sourceDirectory, "devices.json");
if (await Bun.file(legacy).exists()) {
  await copyFile(legacy, path.join(privateDirectory, "devices.json"));
}
await Effect.runPromise(
  Effect.scoped(
    Layer.build(
      layer({
        databasePath,
        migrationsFolder: path.resolve("apps/server/drizzle"),
      })
    )
  )
);
if (await Bun.file(path.join(privateDirectory, "devices.json")).exists()) {
  migrateTrustStore(path.join(privateDirectory, "devices.json"), databasePath);
}
const mint = (scope: "node" | "daily") => {
  const token = randomBytes(32).toString("base64url");
  mutateTrustStore(
    databasePath,
    () => readTrustStrict(databasePath),
    (store) => ({
      store: {
        ...store,
        keys: [
          ...store.keys,
          {
            addedAt: new Date().toISOString(),
            id: randomBytes(6).toString("hex"),
            label: `transfer-${scope}`,
            lastUsedAt: null,
            personId: "host",
            scope,
            tokenHash: hashToken(token),
          },
        ],
      },
      value: undefined,
    })
  );
  return token;
};
const node = mint("node");
const host = mint("daily");
const run = async (source: string) => {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "transfer-group.ts")],
    {
      env: {
        ...process.env,
        ORBIS_NODE_KEY: node,
        ORBIS_TRANSFER_HOST_KEY: host,
        ORBIS_TRANSFER_SOURCE: source,
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, errors);
  const result = output.trim().split("\n").at(-1);
  assert.ok(result);
  return result;
};
const liveResult = await run(databasePath);
const richPath = path.join(artifact, "rich.sqlite");
const source = new Database(databasePath, { readonly: true });
try {
  source.run("VACUUM INTO ?", [richPath]);
} finally {
  source.close();
}
const rich = new Database(richPath);
try {
  const entries = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ set_id: Schema.String }))
  )(
    rich
      .query(
        "SELECT set_id FROM library_entries WHERE person_id = 'host' ORDER BY rowid LIMIT 2"
      )
      .all()
  );
  const [first, second] = entries;
  assert.ok(first);
  assert.ok(second);
  rich.run(
    "INSERT INTO playlists(id,name,created_at,creator_id,collaborative) VALUES(?,?,?,?,?)",
    [
      "transfer-playlist",
      "Transfer 'order'\nfixture",
      "2026-10-03T00:00:00Z",
      "host",
      1,
    ]
  );
  rich.run(
    "INSERT INTO playlist_sets(playlist_id,set_id,position) VALUES(?,?,?)",
    ["transfer-playlist", second.set_id, 0]
  );
  rich.run(
    "INSERT INTO playlist_sets(playlist_id,set_id,position) VALUES(?,?,?)",
    ["transfer-playlist", first.set_id, 1]
  );
  rich.run(
    "INSERT INTO set_cues(set_id,position,start_seconds,artist,title) VALUES(?,?,?,?,?)",
    [first.set_id, 0, null, "Transfer artist", "First cue"]
  );
  rich.run(
    "INSERT INTO set_cues(set_id,position,start_seconds,artist,title) VALUES(?,?,?,?,?)",
    [first.set_id, 1, 42, "Transfer artist", "Second 'cue'\nUnicode 🎵"]
  );
  rich.run("UPDATE sets SET tracklist_state='ready' WHERE id=?", [
    first.set_id,
  ]);
  rich.run(
    "UPDATE library_entries SET title_override=? WHERE person_id='host' AND set_id=?",
    ["Edited 'title'\nUnicode 🎵", first.set_id]
  );
} finally {
  rich.close();
}
await chmod(richPath, 0o600);
const richResult = await run(richPath);
const result = path.join(artifact, "result.json");
await writeFile(
  result,
  JSON.stringify(
    {
      liveSnapshot: liveResult,
      nonemptyPlaylistAndTracklist: richResult,
      sourceNeverWritten: true,
    },
    null,
    2
  )
);
console.log(result);
