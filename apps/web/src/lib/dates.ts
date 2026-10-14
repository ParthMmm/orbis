const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export const formatDate = (iso: string): string =>
  dateFormat.format(new Date(iso));

export const lastUsedText = (iso: string | null): string =>
  iso === null ? "Never used" : `Last used ${formatDate(iso)}`;
