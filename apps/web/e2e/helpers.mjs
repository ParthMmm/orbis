// Journeys that are not about signing in start with a key already in the
// browser, stored where the sign-in page stores the key the API returns.
export const signInWithKey = async (page, webUrl, key) => {
  await page.goto(`${webUrl}/sign-in`);
  await page.evaluate(
    (value) => localStorage.setItem("orbis.apiKey", value),
    key
  );
  await page.goto(webUrl);
};

export const textOf = async (locator) => {
  const text = await locator.textContent();
  return text.trim();
};
