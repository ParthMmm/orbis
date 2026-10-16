import { callOrbis, problemFor } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/** Host-only calls (ADR 0020). They carry the Host's own signed-in key. */

const unwrap = <A>(result: ApiResult<A>): A => {
  if (!result.ok) {
    throw new Error(problemFor(result));
  }
  return result.value;
};

/** Everything the admin page shows. A failure surfaces as the route's problem. */
export const loadAdmin = async (credentials: Credentials) => {
  const [passcode, people, keys] = await Promise.all([
    callOrbis(credentials, (client) => client.admin.passcode()),
    callOrbis(credentials, (client) => client.admin.people()),
    callOrbis(credentials, (client) => client.admin.keys()),
  ]);
  return {
    keys: unwrap(keys).keys,
    passcode: unwrap(passcode).passcode,
    people: unwrap(people).people,
  };
};

export type AdminData = Awaited<ReturnType<typeof loadAdmin>>;
export type AdminPerson = AdminData["people"][number];
export type AdminKey = AdminData["keys"][number];

/** Opens joining with a fresh random passcode; the one before stops working. */
export const newPasscode = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.admin.newPasscode());

export const closeJoining = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.admin.closeJoining());

export const signInCodeFor = (credentials: Credentials, personId: string) =>
  callOrbis(credentials, (client) =>
    client.admin.signInCodeFor({ params: { id: personId } })
  );

export const removePerson = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.admin.removePerson({ params: { id } })
  );

/** A daily key for a client that cannot sign in by code, such as Raycast. */
export const createKey = (
  credentials: Credentials,
  personId: string,
  label: string
) =>
  callOrbis(credentials, (client) =>
    client.admin.addKey({ params: { id: personId }, payload: { label } })
  );

export const revokeKey = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.admin.revokeKey({ params: { id } })
  );
