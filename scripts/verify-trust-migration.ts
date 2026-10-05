import "../apps/server/src/trust-storage-bun.js";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  decodeTrust,
  migrateTrustStore,
  readTrustStrict,
} from "../apps/server/src/identity.js";

const [source, scratch] = process.argv.slice(2);
if (!source || !scratch) {
  throw new Error(
    "Usage: bun scripts/verify-trust-migration.ts <source directory> <new scratch directory>"
  );
}
assert.notEqual(path.resolve(source), path.resolve(scratch));
mkdirSync(scratch, { mode: 0o700 });
const sourceDatabase = new Database(path.join(source, "library.sqlite"), {
  readonly: true,
});
try {
  writeFileSync(
    path.join(scratch, "library.sqlite"),
    sourceDatabase.serialize(),
    { mode: 0o600 }
  );
} finally {
  sourceDatabase.close();
}
const json = readFileSync(path.join(source, "devices.json"), "utf-8");
writeFileSync(path.join(scratch, "devices.json"), json, { mode: 0o600 });
const before = decodeTrust(JSON.parse(json));
migrateTrustStore(path.join(scratch, "devices.json"));
const after = readTrustStrict(path.join(scratch, "library.sqlite"));
assert.equal(after.keys.length, before.keys.length);
assert.equal(after.people.length, before.people.length);
assert.equal(after.invites?.length ?? 0, before.invites?.length ?? 0);
assert.deepEqual(after.keys, before.keys);
assert.deepEqual(
  after.people,
  before.people.map((person) => ({
    ...person,
    autoDownload: person.autoDownload ?? true,
    filters: person.filters ?? [],
    social: person.social ?? false,
  }))
);
assert.deepEqual(after.invites ?? [], before.invites ?? []);
const result = {
  digestsPersonAndScopePreserved: true,
  invites: after.invites?.length ?? 0,
  keys: after.keys.length,
  people: after.people.length,
  sourceOpenedReadOnly: true,
};
writeFileSync(
  path.join(scratch, "verification.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  { mode: 0o600 }
);
console.log(JSON.stringify(result));
