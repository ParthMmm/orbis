import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

test("a creator grants and revokes collaborative Playlist editing, and reading, through Social visibility", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-collaborative-"));
  const tokens = { a: "creator-key", b: "editor-key" };
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: Object.entries(tokens).map(([personId, token]) => ({
        addedAt: "2026-09-29T00:00:00.000Z",
        id: `${personId}-key`,
        label: "test",
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
  type Payload =
    | { name: string }
    | { url: string }
    | { social: boolean }
    | { appear: boolean }
    | { see: boolean }
    | { collaborative: boolean }
    | { editorIds: string[] }
    | { setIds: string[] };
  const call = (
    who: "a" | "b",
    method: string,
    url: string,
    payload?: Payload
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
  try {
    const created = await call("a", "POST", "/playlists", { name: "Together" });
    expect(created.statusCode).toBe(201);
    const playlistId = created.json().id;
    const collaboration = `/playlists/${playlistId}/collaboration`;
    const editors = `/playlists/${playlistId}/editors`;
    const members = `/playlists/${playlistId}/sets`;
    const setOne = await call("b", "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const setTwo = await call("b", "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=lmnopqrstuv",
    });
    expect(setOne.statusCode).toBe(201);
    expect(setTwo.statusCode).toBe(201);

    expect(await status("a", "PUT", editors, { editorIds: ["b"] })).toBe(404);
    expect(await status("a", "PATCH", "/me", { social: true })).toBe(200);
    expect(await status("b", "PATCH", "/me", { social: true })).toBe(200);
    const enabled = await call("a", "PUT", collaboration, {
      collaborative: true,
    });
    expect(enabled.json()).toEqual({ collaborative: true, editorIds: [] });
    const granted = await call("a", "PUT", editors, { editorIds: ["b"] });
    expect(granted.json()).toEqual({ collaborative: true, editorIds: ["b"] });

    const sharedWith = async (who: "a" | "b") => {
      const response = await call(who, "GET", "/playlists/shared");
      expect(response.statusCode).toBe(200);
      return response.json().playlists;
    };
    expect(await sharedWith("b")).toEqual([
      {
        createdAt: created.json().createdAt,
        creator: { id: "a", username: "alice" },
        id: playlistId,
        name: "Together",
        setCount: 0,
      },
    ]);
    expect(await sharedWith("a")).toEqual([]);
    const editorOwned = await call("b", "GET", "/playlists");
    expect(editorOwned.json().playlists).toEqual([]);

    const added = await call("b", "PUT", members, {
      setIds: [setTwo.json().id, setOne.json().id],
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setTwo.json().id,
      setOne.json().id,
    ]);
    const creatorLibrary = await call("a", "GET", "/sets");
    expect(creatorLibrary.json().sets).toEqual([]);
    const reordered = await call("b", "PUT", members, {
      setIds: [setOne.json().id, setTwo.json().id],
    });
    expect(reordered.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setOne.json().id,
      setTwo.json().id,
    ]);
    const creatorView = await call("a", "GET", `/playlists/${playlistId}`);
    expect(creatorView.statusCode).toBe(200);
    expect(creatorView.json()).toMatchObject({
      creator: { id: "a", username: "alice" },
      id: playlistId,
      name: "Together",
      role: "creator",
      setCount: 2,
    });
    const editorView = await call("b", "GET", `/playlists/${playlistId}`);
    expect(editorView.json()).toMatchObject({
      creator: { id: "a", username: "alice" },
      role: "editor",
      setCount: 2,
    });
    expect(editorView.json().sets.map((set: { id: string }) => set.id)).toEqual(
      [setOne.json().id, setTwo.json().id]
    );
    expect(await status("b", "GET", "/playlists/missing")).toBe(404);

    const removed = await call("b", "PUT", members, {
      setIds: [setOne.json().id],
    });
    expect(removed.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setOne.json().id,
    ]);
    expect(
      await status("b", "PATCH", `/playlists/${playlistId}`, {
        name: "Changed",
      })
    ).toBe(404);
    expect(await status("b", "DELETE", `/playlists/${playlistId}`)).toBe(404);
    expect(await status("b", "PUT", editors, { editorIds: [] })).toBe(404);
    expect(
      await status("b", "PUT", collaboration, { collaborative: false })
    ).toBe(404);

    expect(
      await status("a", "PUT", "/people/b/filters", { appear: false })
    ).toBe(200);
    expect(
      await status("b", "PUT", members, {
        setIds: [setOne.json().id, setTwo.json().id],
      })
    ).toBe(404);
    expect(await sharedWith("b")).toEqual([]);
    expect(await status("b", "GET", `/playlists/${playlistId}`)).toBe(404);
    expect(
      await status("a", "PUT", "/people/b/filters", { appear: true })
    ).toBe(200);
    expect(await sharedWith("b")).toHaveLength(1);
    expect(
      await status("b", "PUT", members, {
        setIds: [setOne.json().id, setTwo.json().id],
      })
    ).toBe(200);
    expect(await status("a", "PUT", "/people/b/filters", { see: false })).toBe(
      200
    );
    expect(await status("b", "PUT", members, { setIds: [] })).toBe(404);
    expect(await status("a", "PUT", "/people/b/filters", { see: true })).toBe(
      200
    );
    expect(
      await status("b", "PUT", members, { setIds: [setOne.json().id] })
    ).toBe(200);
    expect(
      await status("a", "PUT", collaboration, { collaborative: false })
    ).toBe(200);
    expect(await status("b", "PUT", members, { setIds: [] })).toBe(404);
    expect(await status("b", "GET", `/playlists/${playlistId}`)).toBe(404);
    expect(await sharedWith("b")).toEqual([]);
    expect(await status("a", "PUT", editors, { editorIds: [] })).toBe(200);
    expect(
      await status("a", "PUT", collaboration, { collaborative: true })
    ).toBe(200);
    expect(await sharedWith("b")).toEqual([]);
    expect(await status("b", "GET", `/playlists/${playlistId}`)).toBe(404);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
