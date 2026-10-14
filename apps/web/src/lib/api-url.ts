export const apiUrl = (): string => {
  const url = process.env.ORBIS_API_URL;
  if (!url) {
    throw new Error("ORBIS_API_URL is not set.");
  }
  return url;
};
