import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

export const waitFor = async (url) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(url);
      return;
    } catch {
      // Not listening yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(100);
  }
  throw new Error(`${url} did not start`);
};

/** A key as the trust store's `devices.json` seeds it. */
export const keyRecord = (id, label, personId, token, scope = "daily") => ({
  addedAt: new Date().toISOString(),
  id,
  label,
  lastUsedAt: null,
  personId,
  scope,
  tokenHash: createHash("sha256").update(token).digest("hex"),
});

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

export const storedKey = (page) =>
  page.evaluate(() => localStorage.getItem("orbis.apiKey"));

export const textOf = async (locator) => {
  const text = await locator.textContent();
  return text.trim();
};

/**
 * Fills a form's fields by label, submits it, and returns the API's answer to
 * the POST it sends, so a step can compare the page with what the API said.
 */
export const submitForm = async (form, pathname, fields) => {
  for (const [label, value] of Object.entries(fields)) {
    // eslint-disable-next-line no-await-in-loop
    await form.getByLabel(label).fill(value);
  }
  const answer = form
    .page()
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === pathname &&
        response.request().method() === "POST"
    );
  await form.getByRole("button").click();
  const response = await answer;
  return {
    body: await response.json(),
    payload: response.request().postDataJSON(),
    status: response.status(),
  };
};
