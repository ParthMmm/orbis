import { Database as SqliteDatabase } from "bun:sqlite";
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
    const playlist = await call("b", "POST", "/playlists", {
      name: "Late night",
    });
    expect(playlist.statusCode).toBe(201);
    const playlistId = playlist.json().id;
    const members = await request(app, {
      accessMode: "device",
      headers: { authorization: `Bearer ${tokens.b}` },
      host: "vanta.example.ts.net",
      method: "PUT",
      payload: { setIds: [second.json().id, first.json().id] },
      url: `/playlists/${playlistId}/sets`,
    });
    expect(members.statusCode).toBe(200);
    const outside = await call("a", "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=zyxwvutsrqp",
    });
    expect(outside.statusCode).toBe(201);
    const sqlite = new SqliteDatabase(path.join(directory, "library.sqlite"));
    sqlite
      .query("UPDATE sets SET download_state = 'ready' WHERE id IN (?, ?)")
      .run(first.json().id, second.json().id);
    sqlite
      .query(
        "INSERT INTO playlist_sets (playlist_id, set_id, position) VALUES (?, ?, 2)"
      )
      .run(playlistId, outside.json().id);
    sqlite
      .query(
        "INSERT INTO listens (person_id, set_id, started_at, finished_at) VALUES ('b', ?, '2026-09-30T00:00:00.000Z', NULL)"
      )
      .run(outside.json().id);
    sqlite.close();
    expect(
      await status("b", "PUT", "/queue/active", { setId: first.json().id })
    ).toBe(200);
    expect(
      await status("b", "POST", "/queue/completion", { setId: first.json().id })
    ).toBe(200);
    expect(
      await status("b", "PUT", "/queue/active", { setId: second.json().id })
    ).toBe(200);
    const friend = "/people/b/sets";
    const friendPlaylists = "/people/b/playlists";
    const friendListens = "/people/b/listens";
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await status("a", "GET", friendPlaylists)).toBe(404);
    expect(await status("a", "GET", friendListens)).toBe(404);
    expect(await body("a", "GET", "/people")).toEqual({ people: [] });

    expect(await status("a", "PATCH", "/me", { social: true })).toBe(200);
    expect(await status("b", "PATCH", "/me", { social: true })).toBe(200);
    const visible = await call("a", "GET", friend);
    expect(visible.statusCode).toBe(200);
    const visibleIds = visible.json().sets.map((set: { id: string }) => set.id);
    expect(visibleIds).toHaveLength(2);
    expect(visibleIds).toContain(first.json().id);
    expect(visibleIds).toContain(second.json().id);
    const visiblePlaylists = await body("a", "GET", friendPlaylists);
    expect(visiblePlaylists.playlists).toMatchObject([
      { id: playlistId, name: "Late night" },
    ]);
    expect(
      visiblePlaylists.playlists[0].sets.map((set: { id: string }) => set.id)
    ).toEqual([second.json().id, first.json().id, outside.json().id]);
    const visibleListens = await body("a", "GET", friendListens);
    expect(
      visibleListens.listens.map(
        (listen: { set: { id: string }; finishedAt: string | null }) => [
          listen.set.id,
          listen.finishedAt !== null,
        ]
      )
    ).toEqual([
      [outside.json().id, false],
      [second.json().id, false],
      [first.json().id, true],
    ]);
    expect(await body("a", "GET", "/people")).toMatchObject({
      people: [{ id: "b", username: "bob" }],
    });

    expect(await status("a", "PUT", "/people/b/filters", { see: false })).toBe(
      200
    );
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await status("a", "GET", friendPlaylists)).toBe(404);
    expect(await status("a", "GET", friendListens)).toBe(404);
    expect(await body("a", "GET", "/people")).toEqual({ people: [] });
    expect(await status("a", "PUT", "/people/b/filters", { see: true })).toBe(
      200
    );
    expect(
      await status("b", "PUT", "/people/a/filters", { appear: false })
    ).toBe(200);
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await status("a", "GET", friendPlaylists)).toBe(404);
    expect(await status("a", "GET", friendListens)).toBe(404);
    expect(
      await status("b", "PUT", "/people/a/filters", { appear: true })
    ).toBe(200);
    expect(await status("a", "GET", friend)).toBe(200);
    expect(await status("b", "PATCH", "/me", { social: false })).toBe(200);
    expect(await status("a", "GET", friend)).toBe(404);
    expect(await status("a", "GET", friendPlaylists)).toBe(404);
    expect(await status("a", "GET", friendListens)).toBe(404);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
