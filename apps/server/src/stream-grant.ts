import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export { issueStreamGrant, verifyStreamGrant } from "./stream-grant-core.js";
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
