import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1000;

export const grantSecret = (file: string | undefined): Buffer => {
  if (!file) {
    return randomBytes(32);
  }
  let secret: Buffer;
  try {
    secret = readFileSync(file);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    try {
      writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (
        !(writeError instanceof Error) ||
        !("code" in writeError) ||
        writeError.code !== "EEXIST"
      ) {
        throw writeError;
      }
    }
    secret = readFileSync(file);
  }
  if (secret.length !== 32) {
    throw new Error("Invalid stream grant secret");
  }
  return secret;
};

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
