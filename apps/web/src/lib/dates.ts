const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export const formatDate = (iso: string): string =>
  dateFormat.format(new Date(iso));

/** When a key was last used, such as "Last used Oct 10, 2026". */
export const lastUsedText = (iso: string | null): string =>
  iso === null ? "Never used" : `Last used ${formatDate(iso)}`;
