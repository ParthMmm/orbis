import "./trust-storage-bun.js";
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  emptyTrustStore,
  hashToken,
  HOST_PERSON_ID,
  mutateTrustStore,
  readTrustStrict,
} from "./identity.js";
import type { KeyRecord, TrustStore } from "./identity.js";

const usage = `Usage:
  bun src/trust.ts person add --username <name> [--database <path>]
  bun src/trust.ts person list [--database <path>]
  bun src/trust.ts person remove --id <id> [--database <path>]
  bun src/trust.ts key add --person <id> --label <name> [--scope daily|admin] [--database <path>]
  bun src/trust.ts key list [--database <path>]
  bun src/trust.ts key revoke --id <id> [--database <path>]

The default store is library.sqlite. Legacy devices.json is imported once. ORBIS_DATA_DIR
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
  option("database") ??
    option("devices") ??
    path.join(process.env.ORBIS_DATA_DIR ?? "data", "library.sqlite")
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

const mutateStore = <T>(
  change: (store: TrustStore) => {
    readonly store: TrustStore;
    readonly value: T;
  }
): T => mutateTrustStore(target, readStore, change);

const username = (): string => {
  const value = required("username");
  if (value.length > 40) {
    throw new Error("Username must have at most 40 characters.");
  }
  return value;
};

const personAdd = () => {
  const name = username();
  const person = mutateStore((store) => {
    if (
      store.people.some(
        (candidate) =>
          !candidate.removed &&
          candidate.username.toLowerCase() === name.toLowerCase()
      )
    ) {
      throw new Error("That username is already in use.");
    }
    const added = {
      id: randomBytes(8).toString("hex"),
      removed: false,
      username: name,
    };
    return {
      store: { ...store, people: [...store.people, added] },
      value: added,
    };
  });
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
  mutateStore((store) => {
    if (!store.people.some((person) => person.id === id && !person.removed)) {
      throw new Error(`No active Person with id ${id}.`);
    }
    return {
      store: {
        ...store,
        keys: store.keys.filter((key) => key.personId !== id),
        people: store.people.map((person) =>
          person.id === id ? { ...person, removed: true } : person
        ),
      },
      value: undefined,
    };
  });
  console.log(
    `Removed Person ${id}. Their keys stop working on the next request.`
  );
};

const keyAdd = (legacy = false) => {
  const personId = legacy ? HOST_PERSON_ID : required("person");
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
  mutateStore((store) => {
    if (
      !store.people.some((person) => person.id === personId && !person.removed)
    ) {
      throw new Error(`No active Person with id ${personId}.`);
    }
    return {
      store: { ...store, keys: [...store.keys, key] },
      value: undefined,
    };
  });
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
  mutateStore((store) => {
    const keys = store.keys.filter((key) => key.id !== id);
    if (keys.length === store.keys.length) {
      throw new Error(`No paired key with id ${id}.`);
    }
    return { store: { ...store, keys }, value: undefined };
  });
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
