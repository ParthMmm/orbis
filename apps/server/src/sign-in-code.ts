import { randomInt } from "node:crypto";

/** Eight characters from an alphabet without 0/O, 1/I/L look-alikes (ADR 0020). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
/** A flood of requests cannot grow memory past this many live codes. */
const MAX_CODES = 500;

/** Accepts `abcd-efgh`, `ABCD EFGH`, and `ABCDEFGH` as the same code. */
const normalize = (input: string): string =>
  input.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

const newCode = (): string =>
  Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  ).join("");

/**
 * Sign-in Codes, in memory only: a restart cancels them. A code names the
 * Person whose new device redeems it, and works once.
 */
export const makeSignInCodes = (now: () => number = Date.now) => {
  const codes = new Map<
    string,
    { readonly personId: string; readonly expiresAt: number }
  >();
  const sweep = () => {
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= now()) {
        codes.delete(code);
      }
    }
  };

  /** Returns null while too many codes are live. */
  const issue = (personId: string) => {
    sweep();
    if (codes.size >= MAX_CODES) {
      return null;
    }
    let code = newCode();
    while (codes.has(code)) {
      code = newCode();
    }
    const expiresAt = now() + CODE_TTL_MS;
    codes.set(code, { expiresAt, personId });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  };

  /** Forgets the code before returning its Person, so it yields one key. */
  const redeem = (input: string): string | null => {
    const code = normalize(input);
    const entry = codes.get(code);
    codes.delete(code);
    return entry && entry.expiresAt > now() ? entry.personId : null;
  };

  return { issue, redeem };
};
