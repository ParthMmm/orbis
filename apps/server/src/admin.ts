import { randomBytes } from "node:crypto";

import {
  hashToken,
  HOST_PERSON_ID,
  matchesTokenHash,
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

export const requireCurrentPerson = (path: string, id: string) =>
  requirePerson(read(path), id);

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

export const listDevices = (
  path: string,
  personId: string,
  currentKeyId: string
) =>
  listKeys(path, personId)
    .filter((key) => key.scope !== "node")
    .map(({ addedAt, id, label, lastUsedAt }) => ({
      addedAt,
      current: id === currentKeyId,
      id,
      label,
      lastUsedAt,
    }));

const validUsername = (input: string) => {
  const username = input.trim();
  if (!username || username.length > 40) {
    throw new AdminError(400, "Choose a username with 1 to 40 characters.");
  }
  return username;
};

const validLabel = (input: string) => {
  const label = input.trim();
  if (!label || label.length > 100) {
    throw new AdminError(400, "Choose a label with 1 to 100 characters.");
  }
  return label;
};

const newPerson = (store: TrustStore, username: string): PersonRecord => {
  if (
    store.people.some(
      (person) =>
        !person.removed &&
        person.username.toLowerCase() === username.toLowerCase()
    )
  ) {
    throw new AdminError(409, "That username is already in use.");
  }
  return {
    id: Buffer.from(randomBytes(8)).toString("hex"),
    removed: false,
    username,
  };
};

const newDailyKey = (personId: string, label: string) => {
  const token = Buffer.from(randomBytes(32)).toString("base64url");
  const record: KeyRecord = {
    addedAt: new Date().toISOString(),
    id: Buffer.from(randomBytes(6)).toString("hex"),
    label,
    lastUsedAt: null,
    personId,
    scope: "daily",
    tokenHash: hashToken(token),
  };
  const { tokenHash: _hash, ...publicKey } = record;
  return { created: { ...publicKey, token }, record };
};

export const addPerson = (path: string, input: string) => {
  const username = validUsername(input);
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      const person = newPerson(store, username);
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
  input: { readonly label: string }
) => {
  const label = validLabel(input.label);
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      requirePerson(store, personId);
      const key = newDailyKey(personId, label);
      return {
        store: { ...store, keys: [...store.keys, key.record] },
        value: key.created,
      };
    }
  );
};

/**
 * Joins the Group with the Group Passcode (ADR 0020). The passcode is checked
 * before the username, so a wrong guess learns nothing about taken names.
 */
export const joinGroup = (
  path: string,
  input: {
    readonly label: string;
    readonly passcode: string;
    readonly username: string;
  }
) =>
  mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      if (!store.passcode) {
        throw new AdminError(403, "Joining is closed.");
      }
      if (!matchesTokenHash(hashToken(store.passcode), input.passcode.trim())) {
        throw new AdminError(403, "That passcode is not right.");
      }
      const person = newPerson(store, validUsername(input.username));
      const key = newDailyKey(person.id, validLabel(input.label));
      return {
        store: {
          ...store,
          keys: [...store.keys, key.record],
          people: [...store.people, person],
        },
        value: {
          key: key.created.token,
          person: { id: person.id, username: person.username },
        },
      };
    }
  );

export const readPasscode = (path: string) => ({
  passcode: read(path).passcode ?? null,
});

/** A blank or null passcode closes joining. */
export const setPasscode = (path: string, input: string | null) => {
  const passcode = input?.trim() || null;
  return mutateTrustStore(
    path,
    () => read(path),
    (store) => ({ store: { ...store, passcode }, value: { passcode } })
  );
};

// With `ownerId`, only that Person's device keys match, and every other key
// answers the same 404 as a missing one.
export const revokeKey = (path: string, id: string, ownerId?: string) =>
  mutateTrustStore(
    path,
    () => read(path),
    (store) => {
      const key = store.keys.find(
        (candidate) =>
          candidate.id === id &&
          (ownerId === undefined ||
            (candidate.personId === ownerId && candidate.scope !== "node"))
      );
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

export const revokeDevice = (
  path: string,
  personId: string,
  currentKeyId: string,
  id: string
) => {
  const { addedAt, label, lastUsedAt } = revokeKey(path, id, personId);
  return { addedAt, current: id === currentKeyId, id, label, lastUsedAt };
};

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
