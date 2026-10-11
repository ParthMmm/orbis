import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

/** The signed-in Person's daily keys, one per device. Admin keys never appear. */
export const listDevices = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.devices.list());

export type Device = Extract<
  Awaited<ReturnType<typeof listDevices>>,
  { ok: true }
>["value"]["devices"][number];

/** A one-time code that signs another device in as this Person (ADR 0020). */
export const requestSignInCode = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.devices.signInCode());

/** Revokes one of the Person's own keys. Revoking the current one signs this browser out. */
export const revokeDevice = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.devices.revoke({ params: { id } }));
