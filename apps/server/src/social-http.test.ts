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
    expect((await call("a", "GET", friend)).statusCode).toBe(404);
    expect((await call("a", "GET", "/people")).json()).toEqual({ people: [] });

    expect((await call("a", "PATCH", "/me", { social: true })).statusCode).toBe(
      200
    );
    expect((await call("b", "PATCH", "/me", { social: true })).statusCode).toBe(
      200
    );
    const visible = await call("a", "GET", friend);
    expect(visible.statusCode).toBe(200);
    expect(
      visible
        .json()
        .sets.map((set: { id: string }) => set.id)
        .sort()
    ).toEqual([first.json().id, second.json().id].sort());
    expect((await call("a", "GET", "/people")).json()).toMatchObject({
      people: [{ id: "b", username: "bob" }],
    });

    expect(
      (await call("a", "PUT", "/people/b/filters", { see: false })).statusCode
    ).toBe(200);
    expect((await call("a", "GET", friend)).statusCode).toBe(404);
    expect((await call("a", "GET", "/people")).json()).toEqual({ people: [] });
    expect(
      (await call("a", "PUT", "/people/b/filters", { see: true })).statusCode
    ).toBe(200);
    expect(
      (await call("b", "PUT", "/people/a/filters", { appear: false }))
        .statusCode
    ).toBe(200);
    expect((await call("a", "GET", friend)).statusCode).toBe(404);
    expect(
      (await call("b", "PUT", "/people/a/filters", { appear: true })).statusCode
    ).toBe(200);
    expect((await call("a", "GET", friend)).statusCode).toBe(200);
    expect(
      (await call("b", "PATCH", "/me", { social: false })).statusCode
    ).toBe(200);
    expect((await call("a", "GET", friend)).statusCode).toBe(404);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
