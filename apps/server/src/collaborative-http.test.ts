import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

test("a creator grants and revokes collaborative Playlist editing through Social visibility", async () => {
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
  const call = (
    who: "a" | "b",
    method: string,
    url: string,
    payload?: unknown
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

    expect(
      (await call("a", "PUT", editors, { editorIds: ["b"] })).statusCode
    ).toBe(404);
    expect((await call("a", "PATCH", "/me", { social: true })).statusCode).toBe(
      200
    );
    expect((await call("b", "PATCH", "/me", { social: true })).statusCode).toBe(
      200
    );
    const enabled = await call("a", "PUT", collaboration, {
      collaborative: true,
    });
    expect(enabled.json()).toEqual({ collaborative: true, editorIds: [] });
    const granted = await call("a", "PUT", editors, { editorIds: ["b"] });
    expect(granted.json()).toEqual({ collaborative: true, editorIds: ["b"] });

    const added = await call("b", "PUT", members, {
      setIds: [setTwo.json().id, setOne.json().id],
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setTwo.json().id,
      setOne.json().id,
    ]);
    expect((await call("a", "GET", "/sets")).json().sets).toEqual([]);
    const reordered = await call("b", "PUT", members, {
      setIds: [setOne.json().id, setTwo.json().id],
    });
    expect(reordered.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setOne.json().id,
      setTwo.json().id,
    ]);
    const removed = await call("b", "PUT", members, {
      setIds: [setOne.json().id],
    });
    expect(removed.json().sets.map((set: { id: string }) => set.id)).toEqual([
      setOne.json().id,
    ]);
    expect(
      (
        await call("b", "PATCH", `/playlists/${playlistId}`, {
          name: "Changed",
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await call("b", "DELETE", `/playlists/${playlistId}`)).statusCode
    ).toBe(404);
    expect(
      (await call("b", "PUT", editors, { editorIds: [] })).statusCode
    ).toBe(404);
    expect(
      (await call("b", "PUT", collaboration, { collaborative: false }))
        .statusCode
    ).toBe(404);

    expect(
      (await call("a", "PUT", "/people/b/filters", { appear: false }))
        .statusCode
    ).toBe(200);
    expect(
      (
        await call("b", "PUT", members, {
          setIds: [setOne.json().id, setTwo.json().id],
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await call("a", "PUT", "/people/b/filters", { appear: true })).statusCode
    ).toBe(200);
    expect(
      (
        await call("b", "PUT", members, {
          setIds: [setOne.json().id, setTwo.json().id],
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await call("a", "PUT", collaboration, { collaborative: false }))
        .statusCode
    ).toBe(200);
    expect((await call("b", "PUT", members, { setIds: [] })).statusCode).toBe(
      404
    );
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
