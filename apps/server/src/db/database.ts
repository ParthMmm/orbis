import path from "node:path";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { sql } from "drizzle-orm";
import * as SQLiteDrizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Context, Effect, Layer } from "effect";

const CURRENT_SCHEMA_VERSION = 2;

const CREATE_MEMBERSHIP_INDEX =
  "CREATE INDEX IF NOT EXISTS playlist_sets_by_set ON playlist_sets(set_id, playlist_id)";

const LEGACY_MIGRATIONS: readonly (readonly string[])[] = [
  [
    "ALTER TABLE sets ADD COLUMN creator TEXT",
    "ALTER TABLE sets ADD COLUMN artwork_url TEXT",
    "ALTER TABLE sets ADD COLUMN duration_seconds INTEGER",
    "ALTER TABLE sets ADD COLUMN metadata_state TEXT NOT NULL DEFAULT 'pending'",
    // A title was required before this column existed, so every row that predates it holds a
    // title a person typed. The default backfills them as edited, which keeps a metadata retry
    // from replacing a title someone chose. New rows always state the value themselves.
    "ALTER TABLE sets ADD COLUMN title_edited_by_user INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE sets ADD COLUMN download_state TEXT NOT NULL DEFAULT 'none'",
    "ALTER TABLE sets ADD COLUMN retained_audio_bytes INTEGER",
    "ALTER TABLE sets ADD COLUMN retained_audio_format TEXT",
    "ALTER TABLE sets ADD COLUMN playback_position_seconds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sets ADD COLUMN listen_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sets ADD COLUMN finish_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sets ADD COLUMN last_listened_at TEXT",
  ],
  [CREATE_MEMBERSHIP_INDEX],
];

type DatabaseClient = SQLiteDrizzle.EffectSQLiteBunDatabase;

export class Database extends Context.Service<Database, DatabaseClient>()(
  "@orbis/Database"
) {}

const runLegacyMigration = (
  db: DatabaseClient,
  statements: readonly string[]
) =>
  Effect.gen(function* runLegacyMigrationEffect() {
    for (const statement of statements) {
      yield* db.run(sql.raw(statement));
    }
  });

const hasTable = (db: DatabaseClient, name: string) =>
  db.get<{ readonly name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`
  );

const ensureLegacySchema = (db: DatabaseClient) =>
  Effect.gen(function* ensureLegacySchemaEffect() {
    yield* db.run(sql.raw("PRAGMA foreign_keys = ON"));
    const setsTable = yield* hasTable(db, "sets");
    if (!setsTable) {
      return false;
    }

    const versionRow = yield* db.get<{ readonly user_version: number }>(
      sql.raw("PRAGMA user_version")
    );
    const version = versionRow?.user_version ?? 0;
    if (version < CURRENT_SCHEMA_VERSION) {
      yield* db.transaction((tx) =>
        Effect.gen(function* migrateLegacySchema() {
          for (
            let step = version + 1;
            step <= CURRENT_SCHEMA_VERSION;
            step += 1
          ) {
            const statements = LEGACY_MIGRATIONS[step - 1];
            if (statements) {
              yield* runLegacyMigration(tx, statements);
            }
          }
          yield* tx.run(
            sql.raw(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
          );
        })
      );
    }
    return true;
  });

const migrateDatabase = (
  db: DatabaseClient,
  migrationsFolder: string,
  legacyDatabase: boolean
) =>
  Effect.gen(function* migrateDatabaseEffect() {
    const migrationTable = yield* hasTable(db, "__drizzle_migrations");
    if (!migrationTable && legacyDatabase) {
      // Existing Orbis databases were migrated with PRAGMA user_version before Drizzle was
      // introduced. The legacy columns are already in place, so record the Drizzle baseline
      // without replaying its CREATE TABLE statements.
      yield* db.run(
        sql.raw(`
          CREATE TABLE IF NOT EXISTS __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          )
        `)
      );
      const migrations = yield* Effect.try({
        catch: (cause) =>
          new Error(`Could not read database migrations: ${String(cause)}`),
        try: () => readMigrationFiles({ migrationsFolder }),
      });
      const [baseline] = migrations;
      if (!baseline) {
        return yield* Effect.fail(
          new Error("The Drizzle baseline migration is missing.")
        );
      }
      yield* db.run(
        sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES (${baseline.hash}, ${baseline.folderMillis}, ${baseline.name}, ${new Date().toISOString()})
        `
      );
    }
    yield* migrate(db, { migrationsFolder });
    yield* db.run(sql.raw(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`));
  });

export interface DatabaseLayerOptions {
  readonly databasePath: string;
  readonly migrationsFolder: string;
}

export const layer = ({
  databasePath,
  migrationsFolder,
}: DatabaseLayerOptions) =>
  Layer.effect(
    Database,
    Effect.gen(function* createDatabaseLayer() {
      const db = yield* SQLiteDrizzle.makeWithDefaults();
      const legacyDatabase = yield* ensureLegacySchema(db);
      yield* migrateDatabase(
        db,
        path.resolve(migrationsFolder),
        legacyDatabase
      );
      return db;
    })
  ).pipe(
    Layer.provide(
      SqliteClient.layer({
        create: true,
        filename: databasePath,
      })
    )
  );
