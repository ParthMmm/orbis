import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  ACCEPTED_SOURCE_URL_CASES,
  REJECTED_SOURCE_URLS,
} from "@orbis/contracts/source-url-cases";

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
const saveCurrentTabModule = await import("../save-current-tab");
const saveCurrentTab = saveCurrentTabModule.default;

beforeEach(() => {
  resetRaycast();
  resetRequests();
  mockFetch(() => httpStatus(201));
});

// The cases are the server's own, shared through @orbis/contracts, so a change to the
// canonical rule that a command does not follow fails here.
for (const testCase of ACCEPTED_SOURCE_URL_CASES) {
  test(`Save Clipboard submits the canonical link for ${testCase.input}`, async () => {
    raycast.clipboard = `saved from chat: ${testCase.input}`;

    await saveClipboard();

    expect(requests[0]?.body).toBe(
      JSON.stringify({ tags: [], url: testCase.url })
    );
    expect(finalToast()).toMatchObject({ style: "success" });
  });

  test(`Save Current Tab submits the canonical link for ${testCase.input}`, async () => {
    raycast.tabs = [{ active: true, url: testCase.input }];

    await saveCurrentTab();

    expect(requests[0]?.body).toBe(
      JSON.stringify({ tags: [], url: testCase.url })
    );
    expect(finalToast()).toMatchObject({ style: "success" });
  });
}

for (const url of REJECTED_SOURCE_URLS) {
  test(`Save Clipboard rejects ${url} before any request`, async () => {
    raycast.clipboard = url;

    await saveClipboard();

    expect(requests).toEqual([]);
    expect(finalToast()).toMatchObject({
      message: "Use a YouTube or SoundCloud link.",
      style: "failure",
      title: "Unsupported link",
    });
  });

  test(`Save Current Tab rejects ${url} before any request`, async () => {
    raycast.tabs = [{ active: true, url }];
    mockFetch(() => {
      throw new Error("the command must not call Orbis for a rejected link");
    });

    await saveCurrentTab();

    expect(requests).toEqual([]);
    expect(finalToast()).toMatchObject({
      message: "Use a YouTube or SoundCloud link.",
      style: "failure",
      title: "Unsupported link",
    });
  });
}
