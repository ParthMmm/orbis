import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const readTrustStore = (dataDirectory) => {
  const db = new DatabaseSync(path.join(dataDirectory, "library.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      invites: db.prepare("SELECT * FROM invites").all(),
      keys: db
        .prepare(
          "SELECT *, digest AS tokenHash, person_id AS personId FROM api_keys"
        )
        .all(),
      people: db.prepare("SELECT * FROM people").all(),
    };
  } finally {
    db.close();
  }
};
