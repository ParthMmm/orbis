import { callOrbis, callOrbisWithoutKey, FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

/**
 * Invites (ADR 0016): the Host sends a one-time link, and the browser that opens
 * it claims a daily key for the Person it names.
 */

/**
 * The link the Host sends. The code sits in the fragment, so no server or log
 * sees it. In production the origin is https://orbis.p11a.xyz.
 */
export const inviteUrl = (origin: string, code: string): string =>
  `${origin}/claim#${code}`;

/** The code from a `/claim#<code>` address, or null when the link has none. */
export const readInviteCode = (hash: string): string | null => {
  const code = hash.replace(/^#/u, "").trim();
  return code === "" ? null : code;
};

// Called with the Host's admin key.
export const createInvite = (credentials: Credentials, personId: string) =>
  callOrbis(credentials, (client) =>
    client.admin.createInvite({ params: { id: personId } })
  );

export const claimInvite = (apiUrl: string, code: string, label: string) =>
  callOrbisWithoutKey(apiUrl, (client) =>
    client.invites.claim({ payload: { code, label } })
  );

/** Statuses that mean this link will never work, so the page stops offering it. */
export const SPENT_STATUSES: ReadonlySet<number> = new Set([404, 409, 410]);

/** What the page says when the API refuses a claim, by response status. */
const CLAIM_PROBLEMS = new Map([
  [400, "Name this device."],
  [
    404,
    "This Invite link does not work. Check that you opened the whole link, or ask your Host for a new one.",
  ],
  [
    409,
    "This Invite has already been used. If you did not use it, ask your Host for a new one.",
  ],
  [410, "This Invite has expired. Ask your Host for a new one."],
  [429, "Too many attempts. Wait a minute and try again."],
]);

export const claimProblem = (
  result: Extract<ApiResult<unknown>, { ok: false }>
): string =>
  CLAIM_PROBLEMS.get(result.status ?? 0) ?? FAILURE_MESSAGES[result.failure];
