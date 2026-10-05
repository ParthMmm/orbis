import { createHash, timingSafeEqual } from "node:crypto";

import { Schema } from "effect";

import { trustStorage, isTrustBusy } from "./trust-storage.js";

const TokenHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const LegacyDevice = Schema.Struct({
  addedAt: Schema.String,
  id: Schema.String,
  label: Schema.String,
  tokenHash: TokenHash,
});
const Person = Schema.Struct({
  autoDownload: Schema.optionalKey(Schema.Boolean),
  filters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        appear: Schema.Boolean,
        personId: Schema.String,
        see: Schema.Boolean,
      })
    )
  ),
  id: Schema.String,
  removed: Schema.Boolean,
  social: Schema.optionalKey(Schema.Boolean),
  username: Schema.String,
});
const Key = Schema.Struct({
  addedAt: Schema.String,
  id: Schema.String,
  label: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  personId: Schema.String,
  scope: Schema.Literals(["daily", "admin", "node"]),
  tokenHash: TokenHash,
});
/** An Invite (ADR 0016): the store keeps the code's `sha256`, never the code. */
const Invite = Schema.Struct({
  codeHash: TokenHash,
  expiresAt: Schema.String,
  personId: Schema.String,
  used: Schema.Boolean,
});
const LegacyTrustFile = Schema.Struct({
  devices: Schema.Array(LegacyDevice),
  version: Schema.Literal(1),
});
const TrustFile = Schema.Struct({
  invites: Schema.optionalKey(Schema.Array(Invite)),
  keys: Schema.Array(Key),
  people: Schema.Array(Person),
  version: Schema.Literal(2),
});

export type PersonRecord = typeof Person.Type;
export type KeyRecord = typeof Key.Type;
export type InviteRecord = typeof Invite.Type;
export type TrustStore = typeof TrustFile.Type;
export type AccessMode = "local" | "device";

export const HOST_PERSON_ID = "host";
const HOST_PERSON: PersonRecord = {
  id: HOST_PERSON_ID,
  removed: false,
  username: "host",
};
export const emptyTrustStore = (): TrustStore => ({
  keys: [],
  people: [HOST_PERSON],
  version: 2,
});

export type AccessDecision =
  | {
      readonly kind: "accepted";
      readonly keyId: string | null;
      readonly person: PersonRecord;
      readonly scope: "daily" | "admin";
    }
  | {
      readonly kind: "rejected";
      readonly message: string;
      readonly statusCode: number;
    };

const LOCAL_ONLY = "Only local app requests are allowed.";
const NOT_PAIRED = "This device is not paired with your library.";
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u;
const BEARER = /^Bearer[ \t]+(?<token>.+)$/iu;
const USAGE_INTERVAL_MS = 60 * 60 * 1000;

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf-8").digest("hex");

const fromLegacy = (legacy: typeof LegacyTrustFile.Type): TrustStore => ({
  keys: legacy.devices.map((device) => ({
    ...device,
    lastUsedAt: null,
    personId: HOST_PERSON_ID,
    scope: "daily" as const,
  })),
  people: [HOST_PERSON],
  version: 2,
});

export const decodeTrust = (raw: typeof Schema.Unknown.Type): TrustStore => {
  const parsed = Schema.decodeUnknownSync(
    Schema.Union([LegacyTrustFile, TrustFile])
  )(raw);
  return parsed.version === 1 ? fromLegacy(parsed) : parsed;
};

export const migrateTrustStore = (
  storePath: string,
  target = storePath
): void => {
  trustStorage().initialize({
    decode: decodeTrust,
    empty: emptyTrustStore,
    legacyPath: storePath.endsWith(".json") ? storePath : undefined,
    target,
  });
};

export const readTrustStrict = (storePath: string): TrustStore => {
  migrateTrustStore(storePath);
  return trustStorage().read(storePath, decodeTrust);
};

export const mutateTrustStore = <T>(
  storePath: string,
  _read: () => TrustStore,
  change: (store: TrustStore) => {
    readonly store?: TrustStore;
    readonly value: T;
  }
): T => {
  migrateTrustStore(storePath);
  return trustStorage().mutate(storePath, decodeTrust, change);
};

export interface TrustRegistry {
  readonly store: TrustStore;
  readonly storeError?: "unreadable";
}

export const readTrustRegistry = (
  storePath: string | undefined
): TrustRegistry => {
  if (!storePath) {
    return { store: emptyTrustStore() };
  }
  try {
    return { store: readTrustStrict(storePath) };
  } catch {
    return { store: emptyTrustStore(), storeError: "unreadable" };
  }
};

const matchesTokenHash = (storedHash: string, presented: string): boolean => {
  const stored = Buffer.from(storedHash, "hex");
  const digest = Buffer.from(hashToken(presented), "hex");
  return stored.length === digest.length && timingSafeEqual(stored, digest);
};

const rejected = (message: string, statusCode: number): AccessDecision => ({
  kind: "rejected",
  message,
  statusCode,
});

const authenticate = (input: {
  readonly authorization: string | null;
  readonly hasOrigin: boolean;
  readonly host: string;
  readonly mode: AccessMode;
  readonly store: TrustStore;
  readonly requiredScope?: "node";
}):
  | Exclude<AccessDecision, { kind: "accepted" }>
  | (Omit<Extract<AccessDecision, { kind: "accepted" }>, "scope"> & {
      readonly scope: KeyRecord["scope"];
    }) => {
  if (input.hasOrigin) {
    return rejected(LOCAL_ONLY, 403);
  }
  if (input.authorization !== null) {
    const token = BEARER.exec(input.authorization)?.groups?.token;
    const key = token
      ? input.store.keys.find((candidate) =>
          matchesTokenHash(candidate.tokenHash, token)
        )
      : undefined;
    const person = input.store.people.find(
      (candidate) => candidate.id === key?.personId && !candidate.removed
    );
    if (
      key &&
      (input.requiredScope === "node"
        ? key.scope !== "node"
        : key.scope === "node")
    ) {
      return rejected("This key cannot access this route.", 403);
    }
    return key && person
      ? { keyId: key.id, kind: "accepted", person, scope: key.scope }
      : rejected(NOT_PAIRED, 401);
  }
  if (
    !input.requiredScope &&
    input.mode === "local" &&
    LOOPBACK_HOST.test(input.host)
  ) {
    const person = input.store.people.find(
      (candidate) => candidate.id === HOST_PERSON_ID && !candidate.removed
    );
    return {
      keyId: null,
      kind: "accepted",
      person: person ?? HOST_PERSON,
      scope: "admin",
    };
  }
  return rejected(LOCAL_ONLY, 403);
};

export const decideNodeAccess = (
  input: Omit<Parameters<typeof authenticate>[0], "requiredScope">
) => authenticate({ ...input, requiredScope: "node" });

export const decideAccess = (
  input: Omit<Parameters<typeof authenticate>[0], "requiredScope">
): AccessDecision => {
  const decision = authenticate(input);
  if (decision.kind === "rejected") {
    return decision;
  }
  if (decision.scope === "node") {
    return rejected("This key cannot access this route.", 403);
  }
  return { ...decision, scope: decision.scope };
};

export const markKeyUsed = (
  storePath: string | undefined,
  keyId: string | null
): void => {
  if (!storePath || !keyId) {
    return;
  }
  try {
    mutateTrustStore(
      storePath,
      () => readTrustStrict(storePath),
      (store) => {
        const key = store.keys.find((record) => record.id === keyId);
        const now = Date.now();
        if (
          !key ||
          (key.lastUsedAt &&
            now - Date.parse(key.lastUsedAt) < USAGE_INTERVAL_MS)
        ) {
          return { value: undefined };
        }
        return {
          store: {
            ...store,
            keys: store.keys.map((record) =>
              record.id === keyId
                ? { ...record, lastUsedAt: new Date(now).toISOString() }
                : record
            ),
          },
          value: undefined,
        };
      }
    );
  } catch (error) {
    if (error instanceof Error && isTrustBusy(error)) {
      throw error;
    }
    // Usage time is advisory; authentication already checked the current store.
  }
};

export type UpdatePersonResult =
  | { readonly kind: "updated"; readonly person: PersonRecord }
  | { readonly kind: "invalid" | "conflict" | "unavailable" };

export interface PersonUpdate {
  readonly autoDownload?: boolean;
  readonly social?: boolean;
  readonly username?: string;
}

export const updatePerson = (
  storePath: string | undefined,
  personId: string,
  input: PersonUpdate
): UpdatePersonResult => {
  const name = input.username?.trim();
  if (
    (name !== undefined && (!name || name.length > 40)) ||
    (name === undefined &&
      input.autoDownload === undefined &&
      input.social === undefined)
  ) {
    return { kind: "invalid" };
  }
  if (!storePath) {
    return { kind: "unavailable" };
  }
  try {
    return mutateTrustStore<UpdatePersonResult>(
      storePath,
      () => readTrustStrict(storePath),
      (store) => {
        if (
          name !== undefined &&
          store.people.some(
            (person) =>
              !person.removed &&
              person.id !== personId &&
              person.username.toLowerCase() === name.toLowerCase()
          )
        ) {
          return { value: { kind: "conflict" as const } };
        }
        const person = store.people.find(
          (record) => record.id === personId && !record.removed
        );
        if (!person) {
          return { value: { kind: "unavailable" as const } };
        }
        const updated = {
          ...person,
          autoDownload: input.autoDownload ?? person.autoDownload ?? true,
          social: input.social ?? person.social ?? false,
          username: name ?? person.username,
        };
        return {
          store: {
            ...store,
            people: store.people.map((record) =>
              record.id === personId ? updated : record
            ),
          },
          value: { kind: "updated" as const, person: updated },
        };
      }
    );
  } catch (error) {
    if (error instanceof Error && isTrustBusy(error)) {
      throw error;
    }
    return { kind: "unavailable" };
  }
};

type FilterUpdateResult =
  | {
      readonly kind: "updated";
      readonly see: boolean;
      readonly appear: boolean;
    }
  | { readonly kind: "invalid" | "missing" | "unavailable" };

export const updatePersonFilters = (
  storePath: string | undefined,
  ownerId: string,
  targetId: string,
  input: { readonly see?: boolean; readonly appear?: boolean }
): FilterUpdateResult => {
  if (input.see === undefined && input.appear === undefined) {
    return { kind: "invalid" };
  }
  if (!storePath) {
    return { kind: "unavailable" };
  }
  try {
    return mutateTrustStore<FilterUpdateResult>(
      storePath,
      () => readTrustStrict(storePath),
      (store) => {
        const owner = store.people.find(
          (person) => person.id === ownerId && !person.removed
        );
        const target = store.people.find(
          (person) => person.id === targetId && !person.removed
        );
        if (!owner || !target || ownerId === targetId) {
          return { value: { kind: "missing" as const } };
        }
        const previous = owner.filters?.find(
          (filter) => filter.personId === targetId
        );
        const filter = {
          appear: input.appear ?? previous?.appear ?? true,
          personId: targetId,
          see: input.see ?? previous?.see ?? true,
        };
        return {
          store: {
            ...store,
            people: store.people.map((person) =>
              person.id === ownerId
                ? {
                    ...person,
                    filters: [
                      ...(person.filters ?? []).filter(
                        (item) => item.personId !== targetId
                      ),
                      filter,
                    ],
                  }
                : person
            ),
          },
          value: {
            appear: filter.appear,
            kind: "updated" as const,
            see: filter.see,
          },
        };
      }
    );
  } catch (error) {
    if (error instanceof Error && isTrustBusy(error)) {
      throw error;
    }
    return { kind: "unavailable" };
  }
};
