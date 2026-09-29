import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

test("People see a friend's full Library only while both sides allow it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-social-"));
  const tokens = { a: "alice-key", b: "bob-key" };
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: Object.entries(tokens).map(([personId, token]) => ({
        addedAt: "2026-09-29T00:00:00.000Z",
        id: `${personId}-key`,
        label: "phone",
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(token),
      })),
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "a", removed: false, username: "alice" },
        { id: "b", removed: false, username: "bob" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  const call = (
    who: "a" | "b",
    method: string,
    url: string,
    payload?: { [key: string]: string | boolean }
  ) =>
    request(app, {
      accessMode: "device",
      headers: { authorization: `Bearer ${tokens[who]}` },
      host: "vanta.example.ts.net",
      method,
      payload,
      url,
    });
  const status = async (...args: Parameters<typeof call>) => {
    const response = await call(...args);
    return response.statusCode;
  };
  const body = async (...args: Parameters<typeof call>) => {
    const response = await call(...args);
    return response.json();
  };
  try {
    const first = await call("b", "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const second = await call("b", "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=lmnopqrstuv",
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const friend = "/people/b/sets";
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await body("a", "GET", "/people")).toEqual({ people: [] });

    expect(await status("a", "PATCH", "/me", { social: true })).toBe(200);
    expect(await status("b", "PATCH", "/me", { social: true })).toBe(200);
    const visible = await call("a", "GET", friend);
    expect(visible.statusCode).toBe(200);
    const visibleIds = visible.json().sets.map((set: { id: string }) => set.id);
    expect(visibleIds).toHaveLength(2);
    expect(visibleIds).toContain(first.json().id);
    expect(visibleIds).toContain(second.json().id);
    expect(await body("a", "GET", "/people")).toMatchObject({
      people: [{ id: "b", username: "bob" }],
    });

    expect(await status("a", "PUT", "/people/b/filters", { see: false })).toBe(
      200
    );
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await body("a", "GET", "/people")).toEqual({ people: [] });
    expect(await status("a", "PUT", "/people/b/filters", { see: true })).toBe(
      200
    );
    expect(
      await status("b", "PUT", "/people/a/filters", { appear: false })
    ).toBe(200);
    expect(await status("a", "GET", friend)).toBe(404);
    expect(
      await status("b", "PUT", "/people/a/filters", { appear: true })
    ).toBe(200);
    expect(await status("a", "GET", friend)).toBe(200);
    expect(await status("b", "PATCH", "/me", { social: false })).toBe(200);
    expect(await status("a", "GET", friend)).toBe(404);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
