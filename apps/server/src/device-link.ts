import { randomBytes, randomInt } from "node:crypto";

import { hashToken } from "./identity.js";

/** Eight characters from an alphabet without 0/O, 1/I/L look-alikes (ADR 0016). */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
export const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;
/** A flood of starts cannot grow memory past this many live links. */
const MAX_LINKS = 500;

interface DeviceLink {
  readonly expiresAt: number;
  readonly label: string;
  readonly pollHash: string;
  readonly userCode: string;
  approvedBy: string | null;
}

export type LinkLookup =
  | {
      readonly kind: "found";
      readonly label: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "missing" | "expired" | "approved" };

export type LinkPoll =
  | { readonly kind: "pending" | "expired" | "missing" }
  | {
      readonly kind: "approved";
      readonly label: string;
      readonly personId: string;
    };

/** Accepts `abcd-efgh`, `ABCD EFGH`, and `ABCDEFGH` as the same code. */
const normalizeUserCode = (input: string): string =>
  input.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

const newUserCode = (): string =>
  Array.from(
    { length: USER_CODE_LENGTH },
    () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  ).join("");

/**
 * Pending Device Links, in memory only: a restart cancels them and the device
 * starts again. The poll secret is kept as its `sha256`, like a key.
 */
export const makeDeviceLinks = (options: {
  readonly ttlMs: number;
  readonly now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  const byCode = new Map<string, DeviceLink>();
  const byPoll = new Map<string, DeviceLink>();
  const forget = (link: DeviceLink) => {
    byCode.delete(link.userCode);
    byPoll.delete(link.pollHash);
  };
  // An expired link stays one more TTL so its device can learn it expired.
  const sweep = () => {
    for (const link of byCode.values()) {
      if (link.expiresAt + options.ttlMs <= now()) {
        forget(link);
      }
    }
  };
  const live = (userCode: string): DeviceLink | undefined =>
    byCode.get(normalizeUserCode(userCode));

  const start = (label: string) => {
    sweep();
    if (byCode.size >= MAX_LINKS) {
      return null;
    }
    let userCode = newUserCode();
    while (byCode.has(userCode)) {
      userCode = newUserCode();
    }
    const pollSecret = Buffer.from(randomBytes(32)).toString("base64url");
    const link: DeviceLink = {
      approvedBy: null,
      expiresAt: now() + options.ttlMs,
      label,
      pollHash: hashToken(pollSecret),
      userCode,
    };
    byCode.set(userCode, link);
    byPoll.set(link.pollHash, link);
    return { expiresAt: link.expiresAt, pollSecret, userCode };
  };

  const lookup = (userCode: string): LinkLookup => {
    const link = live(userCode);
    if (!link) {
      return { kind: "missing" };
    }
    if (link.expiresAt <= now()) {
      return { kind: "expired" };
    }
    if (link.approvedBy !== null) {
      return { kind: "approved" };
    }
    return { expiresAt: link.expiresAt, kind: "found", label: link.label };
  };

  /** Approving twice is refused, so a second Person cannot take the link over. */
  const approve = (userCode: string, personId: string): LinkLookup => {
    const found = lookup(userCode);
    const link = live(userCode);
    if (found.kind === "found" && link) {
      link.approvedBy = personId;
    }
    return found;
  };

  /** An approved link is forgotten before it is returned, so it yields one key. */
  const poll = (pollSecret: string): LinkPoll => {
    sweep();
    const link = byPoll.get(hashToken(pollSecret));
    if (!link) {
      return { kind: "missing" };
    }
    if (link.expiresAt <= now()) {
      forget(link);
      return { kind: "expired" };
    }
    if (link.approvedBy === null) {
      return { kind: "pending" };
    }
    forget(link);
    return { kind: "approved", label: link.label, personId: link.approvedBy };
  };

  return { approve, lookup, poll, start };
};
