import { randomBytes } from "node:crypto";

import { Schema } from "effect";

import {
  hashToken,
  HOST_PERSON_ID,
  mutateTrustStore,
  readTrustStrict,
} from "../../server/src/identity.js";
import type { KeyRecord } from "../../server/src/identity.js";
import { accessDenied, authorizedRecovery } from "./access.js";
import type { AccessConfiguration } from "./access.js";

const Payload = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export const recoverAdmin = async (
  request: Request,
  env: AccessConfiguration,
  trustPath: string
): Promise<Response> => {
  if (!(await authorizedRecovery(request, env))) {
    return accessDenied();
  }
  if (request.method !== "POST") {
    return new Response(null, {
      headers: { allow: "POST", "cache-control": "no-store" },
      status: 405,
    });
  }
  let label: string;
  try {
    const input = Schema.decodeUnknownSync(Payload)(await request.json());
    label = input.label.trim();
    if (!label) {
      throw new Error("Empty label.");
    }
  } catch {
    return Response.json(
      { message: "Choose a label with 1 to 100 characters." },
      { status: 400 }
    );
  }
  const token = Buffer.from(randomBytes(32)).toString("base64url");
  const key: KeyRecord = {
    addedAt: new Date().toISOString(),
    id: Buffer.from(randomBytes(6)).toString("hex"),
    label,
    lastUsedAt: null,
    personId: HOST_PERSON_ID,
    scope: "admin",
    tokenHash: hashToken(token),
  };
  mutateTrustStore(
    trustPath,
    () => readTrustStrict(trustPath),
    (store) => {
      const host = store.people.find((person) => person.id === HOST_PERSON_ID);
      const people = host
        ? store.people.map((person) =>
            person.id === HOST_PERSON_ID
              ? { ...person, removed: false }
              : person
          )
        : [
            ...store.people,
            { id: HOST_PERSON_ID, removed: false, username: "host" },
          ];
      return {
        store: { ...store, keys: [...store.keys, key], people },
        value: undefined,
      };
    }
  );
  const { tokenHash: _digest, ...publicKey } = key;
  return Response.json(
    { ...publicKey, token },
    { headers: { "cache-control": "no-store" }, status: 201 }
  );
};
