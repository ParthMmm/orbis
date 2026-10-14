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

const { SIGN_IN_HINT, signIn } = await import("../orbis-client");
const saveClipboardModule = await import("../save-clipboard");
const saveClipboard = saveClipboardModule.default;

const signedIn = () =>
  Response.json({
    key: "raycast-key",
    person: { id: "person-1", username: "parth" },
  });

beforeEach(() => {
  resetRaycast();
  resetRequests();
  raycast.preferences = { serviceUrl: "https://orbis.test" };
  mockFetch(() => {
    throw new Error("the command must not call Orbis here");
  });
});

test("Sign In redeems the code without a key, keeps the new key, and saves with it", async () => {
  raycast.preferences = {
    deviceToken: "old-pasted-token",
    serviceUrl: "https://orbis.test",
  };
  mockFetch(signedIn);

  const result = await signIn("  abcd-efgh ");

  expect(result).toEqual({ kind: "signedIn", username: "parth" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://orbis.test/sign-in/code");
  expect(requests[0]?.body).toBe(
    JSON.stringify({ code: "abcd-efgh", label: "Raycast" })
  );
  expect(requests[0]?.headers.authorization).toBeUndefined();

  raycast.clipboard = "https://youtu.be/abcdefghijk";
  mockFetch(() => httpStatus(201));
  await saveClipboard();

  expect(requests.at(-1)?.headers.authorization).toBe("Bearer raycast-key");
  expect(finalToast()).toMatchObject({ style: "success", title: "Set saved" });
});

test("Sign In sends nothing for a blank code", async () => {
  expect(await signIn("   ")).toEqual({
    kind: "failed",
    message: "Type the Sign-in Code from Orbis Settings.",
  });
  expect(requests).toEqual([]);
});

test("Sign In shows the server's message for a used or expired code and keeps the old key", async () => {
  raycast.storage.set("deviceToken", "earlier-key");
  mockFetch(() =>
    Response.json(
      { message: "That code is not valid. Get a new one." },
      { status: 404 }
    )
  );

  expect(await signIn("ABCD-EFGH")).toEqual({
    kind: "failed",
    message: "That code is not valid. Get a new one.",
  });
  expect(raycast.storage.get("deviceToken")).toBe("earlier-key");
});

test("Sign In shows the server's message when it limits attempts", async () => {
  mockFetch(() =>
    Response.json({ message: "Too many invalid keys." }, { status: 429 })
  );

  expect(await signIn("ABCD-EFGH")).toEqual({
    kind: "failed",
    message: "Too many invalid keys.",
  });
});

test("Sign In stores nothing when it cannot read the server's answer", async () => {
  mockFetch(() => Response.json({ key: "raycast-key" }));

  const result = await signIn("ABCD-EFGH");

  expect(result.kind).toBe("failed");
  expect(raycast.storage.size).toBe(0);
});

test("Sign In names the service it could not reach", async () => {
  mockFetch(() => {
    throw new TypeError("fetch failed");
  });

  expect(await signIn("ABCD-EFGH")).toEqual({
    kind: "failed",
    message: "Couldn't reach Orbis at https://orbis.test.",
  });
});

test("Sign In refuses to send a code to a service URL that is not HTTPS", async () => {
  raycast.preferences = { serviceUrl: "http://orbis.test" };

  expect(await signIn("ABCD-EFGH")).toEqual({
    kind: "failed",
    message: "Set the Orbis Service URL to your https:// address.",
  });
  expect(requests).toEqual([]);
});

test("Save Clipboard asks to sign in when there is no key", async () => {
  raycast.clipboard = "https://youtu.be/abcdefghijk";

  await saveClipboard();

  expect(requests).toEqual([]);
  expect(finalToast()).toMatchObject({
    message: SIGN_IN_HINT,
    style: "failure",
    title: "Couldn't save this set",
  });
});
