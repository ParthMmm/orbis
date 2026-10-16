import { createHmac, timingSafeEqual } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const signature = (
  secret: Buffer,
  setId: string,
  personId: string,
  expiry: number
) =>
  createHmac("sha256", secret)
    .update(`${setId}\n${personId}\n${expiry}`)
    .digest("hex");

export const issueStreamGrant = (
  secret: Buffer,
  setId: string,
  personId: string
): string => {
  const expiry = Date.now() + DAY_MS;
  return `${expiry}.${personId}.${signature(secret, setId, personId, expiry)}`;
};

/**
 * Why a grant was accepted or refused. The refusal kinds point at different faults:
 * `bad-signature` is a forged grant or a secret that differs between the Group and the
 * audio node, while `expired` and `future-expiry` on a well-signed grant point at an old
 * URL or clocks that disagree.
 */
export type StreamGrantVerdict =
  | { readonly kind: "valid"; readonly personId: string }
  | {
      readonly kind:
        | "missing"
        | "malformed"
        | "bad-signature"
        | "expired"
        | "future-expiry";
    };

export const checkStreamGrant = (
  secret: Buffer,
  setId: string,
  grant: string | null
): StreamGrantVerdict => {
  if (grant === null || grant === "") {
    return { kind: "missing" };
  }
  const match =
    /^(?<expiry>\d{13})\.(?<personId>[a-zA-Z0-9_-]+)\.(?<mac>[a-f0-9]{64})$/u.exec(
      grant
    );
  if (!match?.groups) {
    return { kind: "malformed" };
  }
  const { expiry: expiryText, personId, mac } = match.groups;
  if (!expiryText || !personId || !mac) {
    return { kind: "malformed" };
  }
  const expiry = Number(expiryText);
  const expected = Buffer.from(
    signature(secret, setId, personId, expiry),
    "hex"
  );
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) {
    return { kind: "bad-signature" };
  }
  if (expiry <= Date.now()) {
    return { kind: "expired" };
  }
  if (expiry > Date.now() + DAY_MS) {
    return { kind: "future-expiry" };
  }
  return { kind: "valid", personId };
};
