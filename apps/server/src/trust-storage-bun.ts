import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import type { decodeTrust, TrustStore } from "./identity.js";
import { configureTrustStorage } from "./trust-storage.js";

let busyTimeout = 5000;
export const useNonblockingTrustStorage = (): void => {
  busyTimeout = 0;
};

const databasePath = (target: string) =>
  target.endsWith(".json")
    ? path.join(path.dirname(target), "library.sqlite")
    : target;

const withDatabase = <T>(target: string, action: (db: Database) => T): T => {
  const db = new Database(databasePath(target), { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
    db.run("PRAGMA foreign_keys = ON");
    return action(db);
  } finally {
    db.close();
  }
};

const writeStore = (db: Database, store: TrustStore): void => {
  db.run("DELETE FROM sign_in_codes");
  db.run("DELETE FROM api_keys");
  db.run("DELETE FROM people");
  const person = db.query(
    "INSERT INTO people (id, username, removed, social, auto_download, filters) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const record of store.people) {
    person.run(
      record.id,
      record.username,
      Number(record.removed),
      Number(record.social ?? false),
      Number(record.autoDownload ?? true),
      JSON.stringify(record.filters ?? [])
    );
  }
  const key = db.query(
    "INSERT INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const record of store.keys) {
    key.run(
      record.id,
      record.tokenHash,
      record.label,
      record.scope,
      record.personId,
      record.addedAt,
      record.lastUsedAt
    );
  }
  const code = db.query(
    "INSERT INTO sign_in_codes (code, person_id, expires_at) VALUES (?, ?, ?)"
  );
  for (const record of store.signInCodes ?? []) {
    code.run(record.code, record.personId, record.expiresAt);
  }
  db.query(
    "INSERT OR REPLACE INTO group_settings (id, passcode) VALUES (1, ?)"
  ).run(store.passcode ?? null);
};

const GROUP_SETTINGS = `CREATE TABLE IF NOT EXISTS group_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), passcode TEXT
)`;
const SIGN_IN_CODES = `CREATE TABLE IF NOT EXISTS sign_in_codes (
  code TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(id),
  expires_at TEXT NOT NULL
)`;

const hasTable = (db: Database, name: string) =>
  db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== null;

const upgradeTrustTables = (db: Database): void => {
  const definition = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE name = 'api_keys'"
    )
    .get();
  if (definition && !definition.sql.includes("'node'")) {
    db.transaction(() => {
      db.run(`CREATE TABLE api_keys_node_scope (
        id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('daily', 'admin', 'node')),
        person_id TEXT NOT NULL REFERENCES people(id), added_at TEXT NOT NULL, last_used_at TEXT
      )`);
      db.run("INSERT INTO api_keys_node_scope SELECT * FROM api_keys");
      db.run("DROP TABLE api_keys");
      db.run("ALTER TABLE api_keys_node_scope RENAME TO api_keys");
    }).immediate();
  }
  if (!hasTable(db, "sign_in_codes")) {
    db.transaction(() => {
      db.run("DROP TABLE IF EXISTS invites");
      db.run("UPDATE api_keys SET scope = 'daily' WHERE scope = 'admin'");
      db.run(GROUP_SETTINGS);
      db.run(SIGN_IN_CODES);
    }).immediate();
  }
};

const initialized = new Set<string>();

export const initializeTrustDatabase = (input: {
  readonly target: string;
  readonly legacyPath?: string | undefined;
  readonly decode: typeof decodeTrust;
  readonly empty: () => TrustStore;
}): void => {
  const legacyPath =
    input.legacyPath ??
    path.join(path.dirname(databasePath(input.target)), "devices.json");
  const file = databasePath(input.target);
  if (initialized.has(file)) {
    return;
  }
  withDatabase(input.target, (db) => {
    if (
      hasTable(db, "trust_migrations") &&
      db.query("SELECT id FROM trust_migrations WHERE id = 1").get()
    ) {
      upgradeTrustTables(db);
      return;
    }
    db.run(`CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, removed INTEGER NOT NULL,
      social INTEGER NOT NULL DEFAULT 0, auto_download INTEGER NOT NULL DEFAULT 1,
      filters TEXT NOT NULL DEFAULT '[]'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('daily', 'node')), person_id TEXT NOT NULL REFERENCES people(id),
      added_at TEXT NOT NULL, last_used_at TEXT
    )`);
    db.run(GROUP_SETTINGS);
    db.run(SIGN_IN_CODES);
    db.run(
      "CREATE TABLE IF NOT EXISTS trust_migrations (id INTEGER PRIMARY KEY CHECK (id = 1))"
    );
    db.transaction(() => {
      if (db.query("SELECT id FROM trust_migrations WHERE id = 1").get()) {
        return;
      }
      const store = existsSync(legacyPath)
        ? input.decode(JSON.parse(readFileSync(legacyPath, "utf-8")))
        : input.empty();
      writeStore(db, store);
      db.run("INSERT INTO trust_migrations (id) VALUES (1)");
    }).immediate();
  });
  initialized.add(file);
  if (existsSync(legacyPath) && !existsSync(`${legacyPath}.migrated`)) {
    try {
      renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          existsSync(`${legacyPath}.migrated`)
        )
      ) {
        throw error;
      }
    }
  }
};

const readStore = (db: Database, decode: typeof decodeTrust): TrustStore => {
  const people = db
    .query<
      {
        id: string;
        username: string;
        removed: number;
        social: number;
        autoDownload: number;
        filters: string;
      },
      []
    >(
      "SELECT id, username, removed, social, auto_download AS autoDownload, filters FROM people ORDER BY rowid"
    )
    .all()
    .map((record) => ({
      ...record,
      autoDownload: Boolean(record.autoDownload),
      filters: JSON.parse(record.filters),
      removed: Boolean(record.removed),
      social: Boolean(record.social),
    }));
  const keys = db
    .query(
      "SELECT id, digest AS tokenHash, label, scope, person_id AS personId, added_at AS addedAt, last_used_at AS lastUsedAt FROM api_keys ORDER BY rowid"
    )
    .all();
  const settings = db
    .query<{ passcode: string | null }, []>(
      "SELECT passcode FROM group_settings WHERE id = 1"
    )
    .get();
  const signInCodes = db
    .query(
      "SELECT code, person_id AS personId, expires_at AS expiresAt FROM sign_in_codes ORDER BY rowid"
    )
    .all();
  return decode({
    keys,
    passcode: settings?.passcode ?? null,
    people,
    signInCodes,
    version: 2,
  });
};

export const readTrustDatabase = (
  target: string,
  decode: typeof decodeTrust
): TrustStore =>
  withDatabase(target, (db) => db.transaction(() => readStore(db, decode))());

export const mutateTrustDatabase = <T>(
  target: string,
  decode: typeof decodeTrust,
  change: (store: TrustStore) => {
    readonly store?: TrustStore;
    readonly value: T;
  }
): T =>
  withDatabase(target, (db) =>
    db
      .transaction(() => {
        const result = change(readStore(db, decode));
        if (result.store) {
          writeStore(db, result.store);
        }
        return result.value;
      })
      .immediate()
  );

configureTrustStorage({
  initialize: initializeTrustDatabase,
  mutate: mutateTrustDatabase,
  read: readTrustDatabase,
});
