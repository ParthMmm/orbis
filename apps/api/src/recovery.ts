import {
  HOST_PERSON_ID,
  mutateTrustStore,
  readTrustStrict,
} from "../../server/src/identity.js";
import { nodeKeyId } from "./node.js";

const noStore = { "cache-control": "no-store" };

/**
 * Recovers the Host with Vanta's node key (ADR 0020). The node key can already
 * export every row, so a Sign-in Code for the Host gives it no new power.
 */
export const recoverHost = (
  request: Request,
  trustPath: string,
  issueSignInCode: (
    personId: string
  ) => { readonly code: string; readonly expiresAt: string } | null
): Response => {
  if (request.method !== "POST") {
    return new Response(null, {
      headers: { allow: "POST", ...noStore },
      status: 405,
    });
  }
  const keyId = nodeKeyId(request, trustPath);
  if (keyId instanceof Response) {
    keyId.headers.set("cache-control", "no-store");
    return keyId;
  }
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
      return { store: { ...store, people }, value: undefined };
    }
  );
  const issued = issueSignInCode(HOST_PERSON_ID);
  if (!issued) {
    return Response.json(
      { message: "Too many Sign-in Codes are waiting. Try again soon." },
      { headers: noStore, status: 503 }
    );
  }
  return Response.json(issued, { headers: noStore, status: 201 });
};
