import { randomBytes } from "node:crypto";

import {
  hashToken,
  HOST_PERSON_ID,
  mutateTrustStore,
  readTrustStrict,
} from "./identity.js";
import type { KeyRecord, PersonRecord, TrustStore } from "./identity.js";

export class AdminError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AdminError";
    this.statusCode = statusCode;
  }
}

const read = (path: string): TrustStore => readTrustStrict(path);

const requirePerson = (store: TrustStore, id: string): PersonRecord => {
  const person = store.people.find(
    (candidate) => candidate.id === id && !candidate.removed
  );
  if (!person) {
    throw new AdminError(404, "Person not found.");
  }
  return person;
};

export const listPeople = (path: string) =>
  read(path)
    .people.filter((person) => !person.removed)
    .map(({ id, username }) => ({ id, username }));

export const listKeys = (path: string, personId?: string) => {
  const store = read(path);
  if (personId) {
    requirePerson(store, personId);
  }
  return store.keys
    .filter((key) => !personId || key.personId === personId)
    .map(({ tokenHash: _hash, ...key }) => key);
};

export const addPerson = (path: string, input: string) => {
  const username = input.trim();
  if (!username || username.length > 40) {
    throw new AdminError(400, "Choose a username with 1 to 40 characters.");
  }
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      if (
        store.people.some(
          (person) =>
            !person.removed &&
            person.username.toLowerCase() === username.toLowerCase()
        )
      ) {
        throw new AdminError(409, "That username is already in use.");
      }
      const person = {
        id: randomBytes(8).toString("hex"),
        removed: false,
        username,
      };
      return {
        store: { ...store, people: [...store.people, person] },
        value: { id: person.id, username },
      };
    }
  );
};

export const addKey = (
  path: string,
  personId: string,
  input: { readonly label: string; readonly scope?: "daily" | "admin" }
) => {
  const label = input.label.trim();
  if (!label || label.length > 100) {
    throw new AdminError(400, "Choose a label with 1 to 100 characters.");
  }
  const scope = input.scope ?? "daily";
  if (scope === "admin" && personId !== HOST_PERSON_ID) {
    throw new AdminError(400, "Only Host can have an admin key.");
  }
  const token = randomBytes(32).toString("base64url");
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      requirePerson(store, personId);
      const key: KeyRecord = {
        addedAt: new Date().toISOString(),
        id: randomBytes(6).toString("hex"),
        label,
        lastUsedAt: null,
        personId,
        scope,
        tokenHash: hashToken(token),
      };
      const { tokenHash: _hash, ...publicKey } = key;
      return {
        store: { ...store, keys: [...store.keys, key] },
        value: { ...publicKey, token },
      };
    }
  );
};

export const revokeKey = (path: string, id: string) =>
  mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      const key = store.keys.find((candidate) => candidate.id === id);
      if (!key) {
        throw new AdminError(404, "Key not found.");
      }
      const { tokenHash: _hash, ...publicKey } = key;
      return {
        store: {
          ...store,
          keys: store.keys.filter((candidate) => candidate.id !== id),
        },
        value: publicKey,
      };
    }
  );

export const removePerson = (path: string, id: string) => {
  if (id === HOST_PERSON_ID) {
    throw new AdminError(400, "Host cannot be removed.");
  }
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      const person = store.people.find((candidate) => candidate.id === id);
      if (!person) {
        throw new AdminError(404, "Person not found.");
      }
      return {
        store: {
          ...store,
          keys: store.keys.filter((key) => key.personId !== id),
          people: store.people.map((candidate) =>
            candidate.id === id ? { ...candidate, removed: true } : candidate
          ),
        },
        value: { id: person.id, username: person.username },
      };
    }
  );
};
