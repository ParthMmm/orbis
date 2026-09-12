import { afterAll, beforeEach, expect, test } from "bun:test";

import { httpStatus, mockFetch, requests, resetRequests } from "./http";
import {
  finalToast,
  installRaycastApi,
  raycast,
  resetRaycast,
} from "./raycast-api";

installRaycastApi();

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const saveClipboardModule = await import("../save-clipboard");
const saveClipboard = saveClipboardModule.default;

beforeEach(() => {
  resetRaycast();
  resetRequests();
  mockFetch(() => {
    throw new Error("the command must not call Orbis for an unsupported link");
  });
});

test("Save Clipboard rejects text without a supported link before any request", async () => {
  raycast.clipboard = "listen to this: https://example.com/playlist/42";

  await saveClipboard();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: "Use a YouTube or SoundCloud link.",
    style: "failure",
    title: "Unsupported link",
  });
});

test("Save Clipboard extracts a link from surrounding text and saves it", async () => {
  raycast.clipboard =
    "Set of the week → https://www.youtube.com/watch?v=abcdefghijk&list=ignored (great)";
  mockFetch(() => httpStatus(201));

  await saveClipboard();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    body: JSON.stringify({
      tags: [],
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    }),
    headers: {
      authorization: "Bearer device-token",
      "content-type": "application/json",
    },
    url: "https://orbis.test/sets",
  });
  expect(raycast.snapshots.at(0)).toMatchObject({
    style: "animated",
    title: "Saving set…",
  });
  expect(finalToast()).toMatchObject({
    message: "https://www.youtube.com/watch?v=abcdefghijk",
    style: "success",
    title: "Set saved",
  });
});

test("Save Clipboard reports a distinct duplicate toast for an already saved link", async () => {
  raycast.clipboard = "https://soundcloud.com/artist/track";
  mockFetch(() => httpStatus(409));

  await saveClipboard();

  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toBe(
    JSON.stringify({ tags: [], url: "https://soundcloud.com/artist/track" })
  );
  expect(finalToast()).toMatchObject({
    message: "https://soundcloud.com/artist/track",
    style: "success",
    title: "Already in your library",
  });
});

test("Save Clipboard names the cause when Orbis cannot be reached", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";
  mockFetch(() => {
    throw new TypeError("fetch failed");
  });

  await saveClipboard();

  expect(finalToast()).toMatchObject({
    message: "Couldn't reach Orbis at https://orbis.test.",
    style: "failure",
    title: "Couldn't save this set",
  });
});

test("Save Clipboard names a timeout", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";
  mockFetch(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });

  await saveClipboard();

  expect(finalToast()).toMatchObject({
    message: "Orbis didn't answer in time. Try again.",
    style: "failure",
  });
});

test("Save Clipboard tells the user to pair again after an auth failure", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";
  mockFetch(() => httpStatus(401));

  await saveClipboard();

  expect(finalToast()).toMatchObject({
    message: "Orbis rejected the device token. Pair this device again.",
    style: "failure",
  });
});

test("Save Clipboard names a service failure by its status", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";
  mockFetch(() => httpStatus(500));

  await saveClipboard();

  expect(finalToast()).toMatchObject({
    message: "Orbis returned HTTP 500.",
    style: "failure",
  });
});

test("Save Clipboard sends nothing for an empty clipboard", async () => {
  raycast.clipboard = "   ";

  await saveClipboard();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: "Copy a YouTube or SoundCloud link first.",
    style: "failure",
    title: "No link on the clipboard",
  });
});

test("Save Clipboard refuses a service URL that is not HTTPS", async () => {
  raycast.preferences = {
    deviceToken: "device-token",
    serviceUrl: "http://orbis.test",
  };
  raycast.clipboard = "https://youtu.be/abcdefghijk";

  await saveClipboard();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: "Set the Orbis Service URL to your https:// address.",
    style: "failure",
  });
});
