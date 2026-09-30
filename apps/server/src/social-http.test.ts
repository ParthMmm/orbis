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
    // Newer than the Listens this test records below, whenever it runs.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    sqlite
      .query(
        "INSERT INTO listens (person_id, set_id, started_at, finished_at) VALUES ('b', ?, ?, NULL)"
      )
      .run(outside.json().id, tomorrow);
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

// Ways this list could go wrong, each checked below: it shows a Person while the
// caller's Social is off, shows a Person whose Social is off, shows a removed
// Person or the caller, reveals a Person who hid from the caller (Appear off),
// drops a Person the caller stopped seeing (so See could never be turned back
// on), or reports filters other than the caller's own.
test("A Person lists their See and Appear filters for everyone they could see", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-filters-"));
  const tokens = { a: "alice-key", b: "bob-key", c: "carol-key" };
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
        { id: "c", removed: false, username: "carol" },
        { id: "d", removed: true, social: true, username: "dave" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  const call = (
    who: "a" | "b" | "c",
    method: string,
    url: string,
    payload?: { [key: string]: boolean }
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
  const filters = async (who: "a" | "b" | "c") => {
    const response = await call(who, "GET", "/people/filters");
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  try {
    expect(await filters("a")).toEqual({ people: [] });
    expect(await status("a", "PATCH", "/me", { social: true })).toBe(200);
    // Nobody else has Social on yet.
    expect(await filters("a")).toEqual({ people: [] });
    expect(await status("b", "PATCH", "/me", { social: true })).toBe(200);
    expect(await status("c", "PATCH", "/me", { social: true })).toBe(200);
    expect(await filters("a")).toEqual({
      people: [
        { appear: true, id: "b", see: true, username: "bob" },
        { appear: true, id: "c", see: true, username: "carol" },
      ],
    });

    // Alice stops seeing Bob and stops appearing to Carol: both stay listed.
    expect(await status("a", "PUT", "/people/b/filters", { see: false })).toBe(
      200
    );
    expect(
      await status("a", "PUT", "/people/c/filters", { appear: false })
    ).toBe(200);
    expect(await filters("a")).toEqual({
      people: [
        { appear: true, id: "b", see: false, username: "bob" },
        { appear: false, id: "c", see: true, username: "carol" },
      ],
    });
    // Alice's filters are hers; Bob still lists Alice with his own defaults.
    expect(await filters("b")).toEqual({
      people: [
        { appear: true, id: "a", see: true, username: "alice" },
        { appear: true, id: "c", see: true, username: "carol" },
      ],
    });
    // Carol cannot tell that Alice exists, since Alice hid from her.
    expect(await filters("c")).toEqual({
      people: [{ appear: true, id: "b", see: true, username: "bob" }],
    });

    expect(await status("c", "PATCH", "/me", { social: false })).toBe(200);
    expect(await filters("a")).toEqual({
      people: [{ appear: true, id: "b", see: false, username: "bob" }],
    });
    expect(await filters("c")).toEqual({ people: [] });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
