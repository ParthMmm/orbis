/** A Sign-in Code (ADR 0020) uses an alphabet without 0/O and 1/I/L look-alikes. */
export const SIGN_IN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SIGN_IN_CODE_LENGTH = 8;

/** Accepts `abcd-efgh`, `ABCD EFGH`, and `ABCDEFGH` as the same code. */
export const normalizeSignInCode = (input: string): string =>
  input.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");

/** Shows a code as two groups of four, such as `ABCD-EFGH`. */
export const formatSignInCode = (code: string): string => {
  const normalized = normalizeSignInCode(code);
  const half = SIGN_IN_CODE_LENGTH / 2;
  return normalized.length > half
    ? `${normalized.slice(0, half)}-${normalized.slice(half)}`
    : normalized;
};
