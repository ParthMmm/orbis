import { Database } from "bun:sqlite";
import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  exportDatabase,
  parseDump,
  tableChecksums,
} from "../apps/server/src/sql-transfer.js";

const adapter = (db: Database) => ({
  execute: (
    sql: string,
    bindings: readonly (string | number | null | Uint8Array)[] = []
  ) => {
    db.run(sql, [...bindings]);
  },
  query: (
    sql: string,
    bindings: readonly (string | number | null | Uint8Array)[] = []
  ) => db.query(sql).all(...bindings),
});
const nodeRequest = async (
  url: string,
  method: "GET" | "POST",
  body?: string
) => {
  const key = process.env.ORBIS_NODE_KEY;
  if (!key) {
    throw new Error("Set ORBIS_NODE_KEY to the node key.");
  }
  const options: RequestInit = {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/sql",
    },
    method,
  };
  if (body !== undefined) {
    options.body = body;
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Group ${method} failed with status ${response.status}.`);
  }
  return response;
};
const [command, source, target] = process.argv.slice(2);
if (!command || !source || !target) {
  throw new Error(
    "Usage: bun scripts/data-transfer.ts export <sqlite> <sql> | import <sql> <api-url> | restore <sql> <sqlite> | backup <api-url> <directory>"
  );
}
if (command === "export") {
  const db = new Database(source, { readonly: true });
  try {
    await writeFile(
      target,
      db.transaction(() => exportDatabase(adapter(db)))(),
      { mode: 0o600 }
    );
  } finally {
    db.close();
  }
} else if (command === "import") {
  const sql = await Bun.file(source).text();
  const expected = await tableChecksums(parseDump(sql));
  const response = await nodeRequest(
    `${target.replace(/\/$/u, "")}/import`,
    "POST",
    sql
  );
  if (JSON.stringify(await response.json()) !== JSON.stringify(expected)) {
    throw new Error("Imported checksums differ from the source.");
  }
  console.log("Every table count and checksum matches.");
} else if (command === "restore") {
  const sql = await Bun.file(source).text();
  parseDump(sql);
  if (await Bun.file(target).exists()) {
    throw new Error("Restore destination already exists.");
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const db = new Database(temporary, { create: true });
  try {
    await chmod(temporary, 0o600);
    db.exec(sql);
    if (exportDatabase(adapter(db)) !== sql) {
      throw new Error("Restored data differs from the export.");
    }
    db.close();
    await link(temporary, target);
    await rm(temporary);
  } catch (error) {
    db.close();
    await rm(temporary, { force: true });
    throw error;
  }
} else if (command === "backup") {
  const response = await nodeRequest(
    `${source.replace(/\/$/u, "")}/export`,
    "GET"
  );
  const sql = await response.text();
  const dump = parseDump(sql);
  if (
    dump.tables.every(
      (table) =>
        table.name === "__drizzle_migrations" ||
        table.name === "sqlite_sequence" ||
        table.rows.length === 0
    )
  ) {
    throw new Error("Refusing to back up an empty Group.");
  }
  await mkdir(target, { mode: 0o700, recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  await writeFile(path.join(target, `${stamp}.sql`), sql, { mode: 0o600 });
  const scanned = await Array.fromAsync(new Bun.Glob("*.sql").scan(target));
  const files = scanned.toSorted();
  await Promise.all(
    files
      .slice(0, Math.max(0, files.length - 14))
      .map((file) => rm(path.join(target, file)))
  );
} else {
  throw new Error("Unknown transfer command.");
}
