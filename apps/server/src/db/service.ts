import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect";
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect/db";
import { Context } from "effect";

interface SQLiteQueryEffect extends QueryEffectHKTBase {
  readonly error: EffectDrizzleQueryError;
  readonly context: never;
}

export type DatabaseClient = SQLiteEffectDatabase<SQLiteQueryEffect, unknown>;
export class Database extends Context.Service<Database, DatabaseClient>()(
  "@orbis/Database"
) {}
