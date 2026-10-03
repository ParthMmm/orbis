import type { DurableObjectStorage } from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Drizzle from "drizzle-orm/effect-sqlite-do";
import { migrate } from "drizzle-orm/effect-sqlite-do/migrator";
import { Effect, Layer } from "effect";

import { Database } from "../../server/src/db/service.js";
import migrations from "./migrations.json";

export const databaseLayer = (storage: DurableObjectStorage) =>
  Layer.effect(
    Database,
    Effect.gen(function* initializeDatabase() {
      const db = yield* Drizzle.makeWithDefaults({ storage });
      yield* migrate(db, { migrations });
      return db;
    })
  ).pipe(Layer.provide(SqliteClient.layer({ storage })));
