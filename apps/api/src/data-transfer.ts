import {
  decideNodeAccess,
  hashToken,
  readTrustRegistry,
} from "../../server/src/identity.js";
import {
  databaseIsEmpty,
  exportDatabase,
  importDatabase,
  inspectDatabase,
  parseDump,
  tableChecksums,
} from "../../server/src/sql-transfer.js";
import type { SqlDatabase } from "../../server/src/sql-transfer.js";

export const transferRequest = async (input: {
  readonly request: Request;
  readonly storage: DurableObjectStorage;
  readonly bootstrapDigest: string | undefined;
  readonly trustPath: string;
}): Promise<Response> => {
  const { request, storage } = input;
  const path = new URL(request.url).pathname;
  const method = path === "/import" ? "POST" : "GET";
  if (request.method !== method) {
    return new Response("Method not allowed", { status: 405 });
  }
  const db: SqlDatabase = {
    execute: (sql, bindings = []) => {
      if (sql.startsWith("PRAGMA user_version=")) {
        storage.kv.put("orbis:sqlite-user-version", Number(sql.slice(20)));
        return;
      }
      storage.sql.exec(sql, ...bindings);
    },
    query: (sql, bindings = []) =>
      sql === "PRAGMA user_version"
        ? [
            {
              user_version:
                storage.kv.get<number>("orbis:sqlite-user-version") ?? 0,
            },
          ]
        : storage.sql.exec(sql, ...bindings).toArray(),
  };
  const token = /^Bearer[ \t]+(?<token>.+)$/iu.exec(
    request.headers.get("authorization") ?? ""
  )?.groups?.token;
  if (request.headers.has("origin")) {
    return new Response("Node key required", { status: 403 });
  }
  if (!token) {
    return new Response("Node key required", { status: 401 });
  }
  const digest = hashToken(token);
  const empty =
    databaseIsEmpty(db) && storage.kv.get("orbis:imported") !== true;
  const bootstrap =
    path === "/import" &&
    empty &&
    Boolean(input.bootstrapDigest) &&
    digest === input.bootstrapDigest;
  if (!bootstrap) {
    const registry = readTrustRegistry(input.trustPath);
    const decision = decideNodeAccess({
      authorization: request.headers.get("authorization"),
      hasOrigin: request.headers.has("origin"),
      host: new URL(request.url).host,
      mode: "device",
      store: registry.store,
    });
    if (decision.kind === "rejected") {
      return new Response("Node key required", { status: decision.statusCode });
    }
  }
  try {
    if (path === "/export") {
      const dump = storage.transactionSync(() => exportDatabase(db));
      return new Response(dump, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/sql",
        },
      });
    }
    const dump = parseDump(await request.text());
    storage.transactionSync(() => {
      if (storage.kv.get("orbis:imported") === true) {
        throw new Error("The Group already holds data.");
      }
      importDatabase(db, dump);
      const importedKey = db.query(
        "SELECT api_keys.id FROM api_keys JOIN people ON people.id = api_keys.person_id WHERE api_keys.digest = ? AND api_keys.scope = 'node' AND people.removed = 0",
        [digest]
      );
      if (importedKey.length !== 1) {
        throw new Error("The export must preserve the importing node key.");
      }
      storage.kv.put("orbis:imported", true);
    });
    return Response.json(await tableChecksums(inspectDatabase(db)), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error &&
          error.message === "The Group already holds data."
            ? error.message
            : "Invalid SQL export or incompatible database.",
      },
      {
        status:
          databaseIsEmpty(db) && storage.kv.get("orbis:imported") !== true
            ? 400
            : 409,
      }
    );
  }
};
