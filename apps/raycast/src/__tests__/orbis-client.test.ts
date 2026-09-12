import { beforeEach, expect, test } from "bun:test";

import { installRaycastApi, resetRaycast } from "./raycast-api";

installRaycastApi();
beforeEach(resetRaycast);

const orbisClient = await import("../orbis-client");
const { canonicalSourceUrl, extractSourceUrl, saveSourceUrl } = orbisClient;

const preferences = {
  deviceToken: "device-token",
  serviceUrl: "https://orbis.test",
};

test("aborts the request at the timeout and names it", async () => {
  const result = await saveSourceUrl("https://youtu.be/abcdefghijk", {
    fetch: (_input, init) => {
      const outcome = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () =>
        outcome.reject(init.signal?.reason)
      );
      return outcome.promise;
    },
    preferences,
    timeoutMs: 10,
  });

  expect(result).toEqual({
    kind: "failed",
    message: "Orbis didn't answer in time. Try again.",
  });
});

test("trims the trailing slash from the configured service URL", async () => {
  const urls: string[] = [];
  await saveSourceUrl("https://youtu.be/abcdefghijk", {
    fetch: (input) => {
      urls.push(String(input));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
    preferences: { ...preferences, serviceUrl: "https://orbis.test/" },
  });

  expect(urls).toEqual(["https://orbis.test/sets"]);
});

test("extracts the first supported link and ignores trailing punctuation", () => {
  expect(
    extractSourceUrl(
      "read https://example.com/notes and then (https://soundcloud.com/artist/track)."
    )
  ).toBe("https://soundcloud.com/artist/track");
});

test("canonicalSourceUrl keeps only a supported source and normalizes it", () => {
  expect(canonicalSourceUrl("https://youtu.be/abcdefghijk?t=30")).toBe(
    "https://www.youtube.com/watch?v=abcdefghijk"
  );
  expect(canonicalSourceUrl("https://example.com/watch?v=abcdefghijk")).toBe(
    null
  );
});
