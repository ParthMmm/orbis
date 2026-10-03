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

export const verifyStreamGrant = (
  secret: Buffer,
  setId: string,
  grant: string
): string | null => {
  const match =
    /^(?<expiry>\d{13})\.(?<personId>[a-zA-Z0-9_-]+)\.(?<mac>[a-f0-9]{64})$/u.exec(
      grant
    );
  if (!match?.groups) {
    return null;
  }
  const { expiry: expiryText, personId, mac } = match.groups;
  if (!expiryText || !personId || !mac) {
    return null;
  }
  const expiry = Number(expiryText);
  if (expiry <= Date.now() || expiry > Date.now() + DAY_MS) {
    return null;
  }
  const expected = Buffer.from(
    signature(secret, setId, personId, expiry),
    "hex"
  );
  return timingSafeEqual(expected, Buffer.from(mac, "hex")) ? personId : null;
};
