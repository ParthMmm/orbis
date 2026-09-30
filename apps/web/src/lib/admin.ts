import { callOrbis } from "@/lib/orbis";
import type { ApiFailure, ApiResult, Credentials } from "@/lib/orbis";

/**
 * The Host's admin key lives in this tab's `sessionStorage` only, so it is gone
 * when the tab closes (ADR 0008). It never goes to `localStorage`.
 */
const ADMIN_KEY_STORAGE = "orbis.adminKey";

export const readAdminKey = (): string | null =>
  sessionStorage.getItem(ADMIN_KEY_STORAGE);

export const storeAdminKey = (key: string): void => {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
};

export const forgetAdminKey = (): void => {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
};

// Every call below carries the admin key, never the Person's daily key.
export const listPeople = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.admin.people());

export const addPerson = (credentials: Credentials, username: string) =>
  callOrbis(credentials, (client) =>
    client.admin.addPerson({ payload: { username } })
  );

export const removePerson = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.admin.removePerson({ params: { id } })
  );

export const listPersonKeys = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) =>
    client.admin.personKeys({ params: { id } })
  );

export const mintKey = (
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

type Success<R> = Awaited<R> extends ApiResult<infer A> ? A : never;
export type AdminPerson = Success<
  ReturnType<typeof listPeople>
>["people"][number];
export type AdminKey = Success<
  ReturnType<typeof listPersonKeys>
>["keys"][number];

/** A missing, unknown, or daily key locks the page again. */
export const locksAdmin = (failure: ApiFailure): boolean =>
  failure === "rejected" || failure === "forbidden";

export const ADMIN_KEY_REQUIRED = "An admin key is required.";
