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

const saveCurrentTabModule = await import("../save-current-tab");
const saveCurrentTab = saveCurrentTabModule.default;

beforeEach(() => {
  resetRaycast();
  resetRequests();
  mockFetch(() => httpStatus(201));
});

test("Save Current Tab submits the active tab as its canonical Source Link", async () => {
  raycast.tabs = [
    { active: false, url: "https://example.com/other" },
    { active: true, url: "https://m.youtube.com/shorts/abcdefghijk/" },
  ];

  await saveCurrentTab();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    body: JSON.stringify({
      tags: [],
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    }),
    url: "https://orbis.test/sets",
  });
  expect(finalToast()).toMatchObject({ style: "success", title: "Set saved" });
});

test("Save Current Tab saves a SoundCloud tab with a temporary server title", async () => {
  raycast.tabs = [
    { active: true, url: "https://soundcloud.com/artist/track?ref=share" },
  ];

  await saveCurrentTab();

  expect(requests[0]?.body).not.toContain("title");
  expect(finalToast()).toMatchObject({
    message: "https://soundcloud.com/artist/track",
    style: "success",
  });
});

test("Save Current Tab rejects an unsupported tab before any request", async () => {
  raycast.tabs = [{ active: true, url: "https://example.com/playlist" }];
  mockFetch(() => {
    throw new Error("the command must not call Orbis for an unsupported tab");
  });

  await saveCurrentTab();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: "Use a YouTube or SoundCloud link.",
    style: "failure",
    title: "Unsupported link",
  });
});

test("Save Current Tab names the cause when the browser extension fails", async () => {
  raycast.getTabsError = new Error("No browser extension connected");
  mockFetch(() => {
    throw new Error("the command must not call Orbis without a tab");
  });

  await saveCurrentTab();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: "No browser extension connected",
    style: "failure",
    title: "Couldn't read the current tab",
  });
});

test("Save Current Tab asks for an active tab when there is none", async () => {
  raycast.tabs = [{ active: false, url: "https://youtu.be/abcdefghijk" }];
  mockFetch(() => {
    throw new Error("the command must not call Orbis without an active tab");
  });

  await saveCurrentTab();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    style: "failure",
    title: "No active tab",
  });
});
