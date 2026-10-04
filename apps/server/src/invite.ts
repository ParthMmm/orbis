import { randomBytes } from "node:crypto";

import { AdminError } from "./admin.js";
import { hashToken, mutateTrustStore, readTrustStrict } from "./identity.js";
import type { InviteRecord, TrustStore } from "./identity.js";

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export type InviteClaim =
  | { readonly kind: "found"; readonly personId: string }
  | { readonly kind: "missing" | "expired" | "used" };

/**
 * A spent or expired Invite stays one more day so its link can say why it
 * failed, then it is dropped.
 */
const live = (store: TrustStore, now: number): readonly InviteRecord[] =>
  (store.invites ?? []).filter(
    (invite) => Date.parse(invite.expiresAt) + INVITE_TTL_MS > now
  );

/** Creates an Invite for a current Person. The code is returned once. */
export const createInvite = (
  path: string,
  personId: string,
  options: { readonly ttlMs: number; readonly now: number }
) => {
  const code = Buffer.from(randomBytes(32)).toString("base64url");
  const expiresAt = new Date(options.now + options.ttlMs).toISOString();
  return mutateTrustStore(
    path,
    () => readTrustStrict(path),
    (store) => {
      if (
        !store.people.some(
          (person) => person.id === personId && !person.removed
        )
      ) {
        throw new AdminError(404, "Person not found.");
      }
      const invite: InviteRecord = {
        codeHash: hashToken(code),
        expiresAt,
        personId,
        used: false,
      };
      return {
        store: { ...store, invites: [...live(store, options.now), invite] },
        value: { code, expiresAt },
      };
    }
  );
};

/**
 * Spends an Invite before any key exists, so two claims of one code cannot
 * both mint. A Person removed since the Invite was made has no Invite.
 */
export const consumeInvite = (
  path: string,
  code: string,
  now: number
): InviteClaim =>
  mutateTrustStore<InviteClaim>(
    path,
    () => readTrustStrict(path),
    (store) => {
      const codeHash = hashToken(code);
      const invites = live(store, now);
      const invite = invites.find(
        (candidate) => candidate.codeHash === codeHash
      );
      const person = store.people.find(
        (candidate) => candidate.id === invite?.personId && !candidate.removed
      );
      if (!invite || !person) {
        return { value: { kind: "missing" } };
      }
      if (invite.used) {
        return { value: { kind: "used" } };
      }
      if (Date.parse(invite.expiresAt) <= now) {
        return { value: { kind: "expired" } };
      }
      return {
        store: {
          ...store,
          invites: invites.map((candidate) =>
            candidate === invite ? { ...candidate, used: true } : candidate
          ),
        },
        value: { kind: "found", personId: invite.personId },
      };
    }
  );
