import { Schema } from "effect";

const Value = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Struct({ hex: Schema.String }),
]);
const Table = Schema.Struct({
  columns: Schema.Array(Schema.String),
  name: Schema.String,
  rows: Schema.Array(Schema.Array(Value)),
  sql: Schema.NullOr(Schema.String),
});
const Dump = Schema.Struct({
  indexes: Schema.Array(Schema.String),
  tables: Schema.Array(Table),
  userVersion: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(2_147_483_647)
  ),
  version: Schema.Literal(1),
});
export type DatabaseDump = typeof Dump.Type;
export interface SqlDatabase {
  readonly query: (
    sql: string,
    bindings?: readonly (string | number | null | Uint8Array)[]
  ) => readonly unknown[];
  readonly execute: (
    sql: string,
    bindings?: readonly (string | number | null | Uint8Array)[]
  ) => void;
}
export const identifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;
const Row = Schema.Record(Schema.String, Schema.Unknown);
const rows = (db: SqlDatabase, sql: string) =>
  Schema.decodeUnknownSync(Schema.Array(Row))(db.query(sql));
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SQLite driver values enter the dump schema here.
const encodeValue = (value: unknown): typeof Value.Type => {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return {
      hex: [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }
  return Schema.decodeUnknownSync(
    Schema.Union([Schema.Null, Schema.String, Schema.Number])
  )(value);
};
// oxlint-disable anti-slop/no-runtime-typeof -- These values already passed the SQL value schema.
const literal = (value: typeof Value.Type): string => {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite SQLite value.");
    }
    return String(value);
  }
  if (typeof value === "string") {
    return value.includes("\0")
      ? `CAST(X'${[...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}' AS TEXT)`
      : `'${value.replaceAll("'", "''")}'`;
  }
  if (!/^(?:[a-f0-9]{2})*$/u.test(value.hex)) {
    throw new Error("Invalid blob.");
  }
  return `X'${value.hex}'`;
};
const decodeValue = (value: typeof Value.Type) =>
  typeof value === "object" && value !== null
    ? Uint8Array.from(value.hex.match(/../gu) ?? [], (byte) =>
        Number.parseInt(byte, 16)
      )
    : value;
// oxlint-enable anti-slop/no-runtime-typeof
export const inspectDatabase = (db: SqlDatabase): DatabaseDump => {
  const tables = rows(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence') ORDER BY name"
  ).map((table) => {
    const name = Schema.decodeUnknownSync(Schema.String)(table.name);
    const sql = Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(
      table.sql
    );
    const columns = rows(db, `PRAGMA table_info(${identifier(name)})`).map(
      (column) => Schema.decodeUnknownSync(Schema.String)(column.name)
    );
    const withoutRowid = /WITHOUT\s+ROWID/iu.test(sql ?? "");
    const fields = withoutRowid ? columns : ["rowid", ...columns];
    const data = rows(
      db,
      `SELECT ${fields.map((field) => (field === "rowid" ? 'rowid AS "__orbis_rowid"' : identifier(field))).join(", ")} FROM ${identifier(name)} ORDER BY ${withoutRowid ? columns.map(identifier).join(", ") : "rowid"}`
    );
    return {
      columns: fields,
      name,
      rows: data.map((row) =>
        fields.map((field) =>
          encodeValue(row[field === "rowid" ? "__orbis_rowid" : field])
        )
      ),
      sql: name === "sqlite_sequence" ? null : sql,
    };
  });
  const indexes = rows(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name"
  ).map((index) => Schema.decodeUnknownSync(Schema.String)(index.sql));
  const [version] = rows(db, "PRAGMA user_version");
  return {
    indexes,
    tables,
    userVersion: Schema.decodeUnknownSync(Schema.Number)(version?.user_version),
    version: 1,
  };
};
export const renderDump = (dump: DatabaseDump): string => {
  const statements = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
  for (const table of dump.tables) {
    if (table.sql) {
      statements.push(`${table.sql};`);
    }
  }
  for (const table of dump.tables) {
    if (table.name === "sqlite_sequence") {
      statements.push("DELETE FROM sqlite_sequence;");
    }
    for (const row of table.rows) {
      statements.push(
        `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(", ")}) VALUES (${row.map(literal).join(", ")});`
      );
    }
  }
  for (const index of dump.indexes) {
    statements.push(`${index};`);
  }
  statements.push(
    `PRAGMA user_version=${dump.userVersion};`,
    "COMMIT;",
    "PRAGMA foreign_keys=ON;"
  );
  return `-- orbis-sql-v1 ${JSON.stringify(dump)}\n${statements.join("\n")}\n`;
};
export const exportDatabase = (db: SqlDatabase): string =>
  renderDump(inspectDatabase(db));
const validateDdl = (ddl: string, kind: "TABLE" | "INDEX"): void => {
  if (!new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?${kind}\\s`, "iu").test(ddl)) {
    throw new Error("Invalid schema definition.");
  }
  let quote = "";
  for (let index = 0; index < ddl.length; index += 1) {
    const character = ddl[index];
    if (quote) {
      if (character === quote) {
        if (ddl[index + 1] === quote) {
          index += 1;
        } else {
          quote = "";
        }
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (
      character === ";" ||
      (character === "-" && ddl[index + 1] === "-") ||
      (character === "/" && ddl[index + 1] === "*")
    ) {
      throw new Error("Multiple schema statements are not allowed.");
    }
  }
  if (quote) {
    throw new Error("Unclosed schema quote.");
  }
};
export const parseDump = (sql: string): DatabaseDump => {
  const [line] = sql.split("\n", 1);
  if (!line?.startsWith("-- orbis-sql-v1 ")) {
    throw new Error("Unsupported SQL export format.");
  }
  const dump = Schema.decodeUnknownSync(Dump)(JSON.parse(line.slice(16)));
  if (renderDump(dump) !== sql) {
    throw new Error("The SQL does not match its manifest.");
  }
  for (const index of dump.indexes) {
    validateDdl(index, "INDEX");
  }
  for (const table of dump.tables) {
    if (table.sql) {
      validateDdl(table.sql, "TABLE");
    }
    if (table.rows.some((row) => row.length !== table.columns.length)) {
      throw new Error("Invalid row length.");
    }
  }
  return dump;
};
export const databaseIsEmpty = (db: SqlDatabase): boolean =>
  inspectDatabase(db).tables.every(
    (table) =>
      table.name === "__drizzle_migrations" ||
      table.name === "sqlite_sequence" ||
      table.rows.length === 0
  );
const tableDefinitions = (value: DatabaseDump) =>
  value.tables.map(({ name, columns }) => ({ columns, name }));
export const importDatabase = (db: SqlDatabase, dump: DatabaseDump): void => {
  if (!databaseIsEmpty(db)) {
    throw new Error("The Group already holds data.");
  }
  const current = inspectDatabase(db);
  if (
    JSON.stringify(tableDefinitions(current)) !==
    JSON.stringify(tableDefinitions(dump))
  ) {
    throw new Error("The export schema does not match the Group schema.");
  }
  db.execute("PRAGMA defer_foreign_keys=ON");
  for (const table of dump.tables) {
    db.execute(`DELETE FROM ${identifier(table.name)}`);
  }
  for (const table of dump.tables) {
    if (table.name === "sqlite_sequence") {
      db.execute("DELETE FROM sqlite_sequence");
    }
    for (const row of table.rows) {
      db.execute(
        `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(", ")}) VALUES (${row.map(() => "?").join(", ")})`,
        row.map(decodeValue)
      );
    }
  }
  if (db.query("PRAGMA foreign_key_check").length) {
    throw new Error("Imported foreign keys are invalid.");
  }
  db.execute(`PRAGMA user_version=${dump.userVersion}`);
};
export const tableChecksums = (dump: DatabaseDump) =>
  Promise.all(
    dump.tables.map(async (table) => ({
      checksum: [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({ columns: table.columns, rows: table.rows })
            )
          )
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      name: table.name,
      rows: table.rows.length,
    }))
  );
