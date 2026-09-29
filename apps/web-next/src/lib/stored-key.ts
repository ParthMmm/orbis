/**
 * The Person's API key lives in this browser only and goes only to the API
 * (ADR 0008). The page's strict CSP is what keeps other scripts away from it.
 */
const KEY_STORAGE = "orbis.apiKey";

export const readKey = (): string | null => localStorage.getItem(KEY_STORAGE);

export const storeKey = (key: string): void => {
  localStorage.setItem(KEY_STORAGE, key);
};

export const forgetKey = (): void => {
  localStorage.removeItem(KEY_STORAGE);
};
