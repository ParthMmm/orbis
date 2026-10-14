import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

export const listDevices = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.devices.list());

export type Device = Extract<
  Awaited<ReturnType<typeof listDevices>>,
  { ok: true }
>["value"]["devices"][number];

export const requestSignInCode = (credentials: Credentials) =>
  callOrbis(credentials, (client) => client.devices.signInCode());

export const revokeDevice = (credentials: Credentials, id: string) =>
  callOrbis(credentials, (client) => client.devices.revoke({ params: { id } }));
