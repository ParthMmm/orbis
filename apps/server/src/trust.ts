import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  emptyTrustStore,
  hashToken,
  HOST_PERSON_ID,
  readTrustStrict,
  writeTrustStore,
} from "./identity.js";
import type { KeyRecord, TrustStore } from "./identity.js";

const usage = `Usage:
  bun src/trust.ts person add --username <name> [--devices <path>]
  bun src/trust.ts person list [--devices <path>]
  bun src/trust.ts person remove --id <id> [--devices <path>]
  bun src/trust.ts key add --person <id> --label <name> [--scope daily|admin] [--devices <path>]
  bun src/trust.ts key list [--devices <path>]
  bun src/trust.ts key revoke --id <id> [--devices <path>]

The default store is devices.json beside the library database. ORBIS_DATA_DIR
sets its directory for the server and this tool. Key tokens print once.`;

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const required = (name: string): string => {
  const value = option(name)?.trim();
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
};

const target = path.resolve(
  option("devices") ??
    path.join(process.env.ORBIS_DATA_DIR ?? "data", "devices.json")
);

const readStore = (): TrustStore => {
  try {
    return readTrustStrict(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyTrustStore();
    }
    throw new Error(
      `${target} could not be read as a trust store, so it was left untouched.`,
      { cause: error }
    );
  }
};

const username = (): string => {
  const value = required("username");
  if (value.length > 40) {
    throw new Error("Username must have at most 40 characters.");
  }
  return value;
};

const personAdd = () => {
  const store = readStore();
  const name = username();
  if (
    store.people.some(
      (person) =>
        !person.removed && person.username.toLowerCase() === name.toLowerCase()
    )
  ) {
    throw new Error("That username is already in use.");
  }
  const person = {
    id: randomBytes(8).toString("hex"),
    removed: false,
    username: name,
  };
  writeTrustStore(target, { ...store, people: [...store.people, person] });
  console.log(`Added Person ${person.id} (${name}).`);
};

const personList = () => {
  for (const person of readStore().people) {
    console.log(
      `${person.id}\t${person.username}\t${person.removed ? "removed" : "active"}`
    );
  }
};

const personRemove = () => {
  const id = required("id");
  if (id === HOST_PERSON_ID) {
    throw new Error("Host cannot be removed.");
  }
  const store = readStore();
  if (!store.people.some((person) => person.id === id && !person.removed)) {
    throw new Error(`No active Person with id ${id}.`);
  }
  writeTrustStore(target, {
    ...store,
    keys: store.keys.filter((key) => key.personId !== id),
    people: store.people.map((person) =>
      person.id === id ? { ...person, removed: true } : person
    ),
  });
  console.log(
    `Removed Person ${id}. Their keys stop working on the next request.`
  );
};

const keyAdd = (legacy = false) => {
  const store = readStore();
  const personId = legacy ? HOST_PERSON_ID : required("person");
  const person = store.people.find(
    (candidate) => candidate.id === personId && !candidate.removed
  );
  if (!person) {
    throw new Error(`No active Person with id ${personId}.`);
  }
  const scope = option("scope") ?? "daily";
  if (scope !== "daily" && scope !== "admin") {
    throw new Error("--scope must be daily or admin.");
  }
  if (scope === "admin" && personId !== HOST_PERSON_ID) {
    throw new Error("Only Host can have an admin key.");
  }
  const label = required("label");
  const token = randomBytes(32).toString("base64url");
  const key: KeyRecord = {
    addedAt: new Date().toISOString(),
    id: randomBytes(6).toString("hex"),
    label,
    lastUsedAt: null,
    personId,
    scope,
    tokenHash: hashToken(token),
  };
  writeTrustStore(target, { ...store, keys: [...store.keys, key] });
  console.log(`Enrolled ${key.id} (${label}) in ${target}.`);
  console.log(`${legacy ? "Device" : "Key"} token, shown once: ${token}`);
};

const keyList = () => {
  const { keys } = readStore();
  if (keys.length === 0) {
    console.log(`No paired devices in ${target}.`);
  }
  for (const key of keys) {
    console.log(
      `${key.id}\t${key.label}\t${key.personId}\t${key.scope}\t${key.lastUsedAt ?? "never"}`
    );
  }
};

const keyRevoke = () => {
  const id = required("id");
  const store = readStore();
  const keys = store.keys.filter((key) => key.id !== id);
  if (keys.length === store.keys.length) {
    throw new Error(`No paired key with id ${id}.`);
  }
  writeTrustStore(target, { ...store, keys });
  console.log(`Removed ${id}. It stops working on the next request.`);
};

const [group, action] = process.argv.slice(2);
try {
  if (group === "person" && action === "add") {
    personAdd();
  } else if (group === "person" && action === "list") {
    personList();
  } else if (group === "person" && action === "remove") {
    personRemove();
  } else if (group === "key" && action === "add") {
    keyAdd();
  } else if (group === "key" && action === "list") {
    keyList();
  } else if (group === "key" && action === "revoke") {
    keyRevoke();
  } else if (group === "add") {
    keyAdd(true);
  } else if (group === "list") {
    keyList();
  } else if (group === "remove") {
    keyRevoke();
  } else {
    console.log(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
