/**
 * The Orbis API address. The Alchemy program sets it on the Worker as
 * ORBIS_API_URL, so a friend never enters it (ADR 0015). Server code only.
 */
export const apiUrl = (): string => {
  const url = process.env.ORBIS_API_URL;
  if (!url) {
    throw new Error("ORBIS_API_URL is not set.");
  }
  return url;
};
