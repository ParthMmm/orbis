import type { decodeTrust, TrustStore } from "../../server/src/identity.js";
import { configureTrustStorage } from "../../server/src/trust-storage.js";

const stores = new Map<string, DurableObjectStorage>();
const storageFor = (target: string) => {
  const storage = stores.get(target);
  if (!storage) {
    throw new Error("Group trust storage is unavailable.");
  }
  return storage;
};

const readStore = (
  storage: DurableObjectStorage,
  decode: typeof decodeTrust
): TrustStore => {
  const people = storage.sql
    .exec<{
      id: string;
      username: string;
      removed: number;
      social: number;
      autoDownload: number;
      filters: string;
    }>(
      "SELECT id, username, removed, social, auto_download AS autoDownload, filters FROM people ORDER BY rowid"
    )
    .toArray()
    .map((person) => ({
      ...person,
      autoDownload: Boolean(person.autoDownload),
      filters: JSON.parse(person.filters),
      removed: Boolean(person.removed),
      social: Boolean(person.social),
    }));
  const keys = storage.sql
    .exec(
      "SELECT id, digest AS tokenHash, label, scope, person_id AS personId, added_at AS addedAt, last_used_at AS lastUsedAt FROM api_keys ORDER BY rowid"
    )
    .toArray();
  const invites = storage.sql
    .exec<{
      codeHash: string;
      personId: string;
      expiresAt: string;
      used: number;
    }>(
      "SELECT digest AS codeHash, person_id AS personId, expires_at AS expiresAt, used FROM invites ORDER BY rowid"
    )
    .toArray()
    .map((invite) => ({ ...invite, used: Boolean(invite.used) }));
  return decode({ invites, keys, people, version: 2 });
};
const writeStore = (storage: DurableObjectStorage, store: TrustStore) => {
  storage.sql.exec("DELETE FROM invites");
  storage.sql.exec("DELETE FROM api_keys");
  storage.sql.exec("DELETE FROM people");
  for (const person of store.people) {
    storage.sql.exec(
      "INSERT INTO people (id, username, removed, social, auto_download, filters) VALUES (?, ?, ?, ?, ?, ?)",
      person.id,
      person.username,
      Number(person.removed),
      Number(person.social ?? false),
      Number(person.autoDownload ?? true),
      JSON.stringify(person.filters ?? [])
    );
  }
  for (const key of store.keys) {
    storage.sql.exec(
      "INSERT INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      key.id,
      key.tokenHash,
      key.label,
      key.scope,
      key.personId,
      key.addedAt,
      key.lastUsedAt
    );
  }
  for (const invite of store.invites ?? []) {
    storage.sql.exec(
      "INSERT INTO invites (digest, person_id, expires_at, used) VALUES (?, ?, ?, ?)",
      invite.codeHash,
      invite.personId,
      invite.expiresAt,
      Number(invite.used)
    );
  }
};

export const registerTrustStorage = (
  target: string,
  storage: DurableObjectStorage
) => {
  stores.set(target, storage);
  configureTrustStorage({
    initialize: ({ target: name, decode }) => {
      readStore(storageFor(name), decode);
    },
    mutate: (name, decode, change) => {
      const selected = storageFor(name);
      return selected.transactionSync(() => {
        const result = change(readStore(selected, decode));
        if (result.store) {
          writeStore(selected, result.store);
        }
        return result.value;
      });
    },
    read: (name, decode) => readStore(storageFor(name), decode),
  });
};
