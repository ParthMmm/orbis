const KEY_STORAGE = "orbis.apiKey";

export const readKey = (): string | null => localStorage.getItem(KEY_STORAGE);

export const storeKey = (key: string): void => {
  localStorage.setItem(KEY_STORAGE, key);
};

export const forgetKey = (): void => {
  localStorage.removeItem(KEY_STORAGE);
};
