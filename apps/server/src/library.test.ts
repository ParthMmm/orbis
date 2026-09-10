import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

test("saves a set with tags and reads it after the server restarts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  let app = createApp({ databasePath });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: ["Techno", " live ", "techno"],
        title: "Night session",
        url: "https://youtu.be/abcdefghijk?t=30",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      source: "youtube",
      tags: ["techno", "live"],
      title: "Night session",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    await app.dispose();
    app = createApp({ databasePath });
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
    expect(library.json()).toEqual({ sets: [saved.json()] });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("saves SoundCloud links and rejects invalid input without changing the library", async () => {
  const app = createApp();
  try {
    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: [],
        title: "Live set",
        url: "https://soundcloud.com/artist/live-set?utm_source=share",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      source: "soundcloud",
      url: "https://soundcloud.com/artist/live-set",
    });
    await Promise.all(
      [
        {
          tags: [],
          title: "Bad",
          url: "https://youtube.com.evil.test/watch?v=abcdefghijk",
        },
        {
          tags: [],
          title: "Bad",
          url: "https://www.youtube.com/watch?v=short",
        },
        { tags: [], title: "Bad", url: ["javascript", "alert(1)"].join(":") },
        { tags: [], title: "Bad", url: "https://soundcloud.com/artist" },
        { tags: [], title: "Bad", url: "https://soundcloud.com/artist/sets" },
        {
          tags: [],
          title: "Bad",
          url: "https://user:password@soundcloud.com/artist/track",
        },
        {
          tags: [],
          title: "Bad",
          url: "https://soundcloud.com:8080/artist/track",
        },
        { tags: [], title: " ", url: "https://soundcloud.com/artist/track" },
        {
          tags: ["x".repeat(41)],
          title: "Bad",
          url: "https://soundcloud.com/artist/track",
        },
        {
          tags: [42],
          title: "Bad",
          url: "https://soundcloud.com/artist/track",
        },
      ].map(async (payload) => {
        const response = await request(app, {
          method: "POST",
          payload,
          url: "/sets",
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      })
    );
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toHaveLength(1);
  } finally {
    await app.dispose();
  }
});

test("duplicate source URLs do not overwrite an existing set", async () => {
  const app = createApp();
  try {
    const payload = {
      tags: ["ambient"],
      title: "Original",
      url: "https://youtu.be/abcdefghijk",
    };
    const first = await request(app, { method: "POST", payload, url: "/sets" });
    const duplicate = await request(app, {
      method: "POST",
      payload: {
        ...payload,
        title: "Replacement",
        url: "https://www.youtube.com/watch?v=abcdefghijk&t=90",
      },
      url: "/sets",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toBe(
      "This set is already in your library."
    );
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json()).toEqual({ sets: [first.json()] });
  } finally {
    await app.dispose();
  }
});

test("combines text, source, and every selected tag when filtering sets", async () => {
  const app = createApp();
  try {
    await Promise.all(
      [
        {
          tags: ["techno", "live"],
          title: "Night session",
          url: "https://youtu.be/abcdefghijk",
        },
        {
          tags: ["techno", "live"],
          title: "Night radio",
          url: "https://soundcloud.com/artist/night",
        },
        {
          tags: ["techno"],
          title: "Night studio",
          url: "https://youtu.be/lmnopqrstuv",
        },
      ].map(async (payload) => {
        const saved = await request(app, {
          method: "POST",
          payload,
          url: "/sets",
        });
        expect(saved.statusCode).toBe(201);
      })
    );
    const filtered = await request(app, {
      method: "GET",
      url: "/sets?q=NIGHT&source=youtube&tag=Techno&tag=live",
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      filtered.json().sets.map((set: { title: string }) => set.title)
    ).toEqual(["Night session"]);
    const missing = await request(app, {
      method: "GET",
      url: "/sets?q=missing",
    });
    expect(missing.json().sets).toEqual([]);
    const literalPercent = await request(app, {
      method: "GET",
      url: "/sets?q=%25",
    });
    expect(literalPercent.json().sets).toEqual([]);
    const invalidSource = await request(app, {
      method: "GET",
      url: "/sets?source=invalid",
    });
    expect(invalidSource.statusCode).toBe(400);
  } finally {
    await app.dispose();
  }
});

test("edits and clears tags while retaining the set and updating tag suggestions", async () => {
  const app = createApp();
  try {
    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: ["house"],
        title: "Afternoon",
        url: "https://soundcloud.com/dj/set",
      },
      url: "/sets",
    });
    const original = saved.json();
    const updated = await request(app, {
      method: "PATCH",
      payload: { tags: [" Ambient ", "ambient", "live"] },
      url: `/sets/${original.id}/tags`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ...original, tags: ["ambient", "live"] });
    const suggestions = await request(app, { method: "GET", url: "/tags" });
    expect(suggestions.json()).toEqual({ tags: ["ambient", "live"] });
    const oldTag = await request(app, {
      method: "GET",
      url: "/sets?tag=house",
    });
    expect(oldTag.json().sets).toEqual([]);
    const invalidTags = await request(app, {
      method: "PATCH",
      payload: { tags: ["x".repeat(41)] },
      url: `/sets/${original.id}/tags`,
    });
    expect(invalidTags.statusCode).toBe(400);
    const missingSet = await request(app, {
      method: "PATCH",
      payload: { tags: [] },
      url: "/sets/missing/tags",
    });
    expect(missingSet.statusCode).toBe(404);
    const cleared = await request(app, {
      method: "PATCH",
      payload: { tags: [] },
      url: `/sets/${original.id}/tags`,
    });
    expect(cleared.statusCode).toBe(200);
    const emptySuggestions = await request(app, {
      method: "GET",
      url: "/tags",
    });
    expect(emptySuggestions.json()).toEqual({ tags: [] });
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toEqual([{ ...original, tags: [] }]);
  } finally {
    await app.dispose();
  }
});

test("updates a set title without changing its source or tags", async () => {
  const app = createApp();
  try {
    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: ["ambient"],
        title: "Old title",
        url: "https://youtu.be/abcdefghijk",
      },
      url: "/sets",
    });
    const original = saved.json();
    const updated = await request(app, {
      method: "PATCH",
      payload: { title: "  New title  " },
      url: `/sets/${original.id}/title`,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ...original, title: "New title" });

    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json()).toEqual({
      sets: [{ ...original, title: "New title" }],
    });
    const blank = await request(app, {
      method: "PATCH",
      payload: { title: "   " },
      url: `/sets/${original.id}/title`,
    });
    expect(blank.statusCode).toBe(400);
    const missing = await request(app, {
      method: "PATCH",
      payload: { title: "Missing" },
      url: "/sets/missing/title",
    });
    expect(missing.statusCode).toBe(404);
  } finally {
    await app.dispose();
  }
});

test("deletes a set and keeps its playlists while removing membership", async () => {
  const app = createApp();
  try {
    const saved = await request(app, {
      method: "POST",
      payload: {
        tags: ["live"],
        title: "To remove",
        url: "https://soundcloud.com/artist/track",
      },
      url: "/sets",
    });
    const set = saved.json();
    const created = await request(app, {
      method: "POST",
      payload: { name: "Keep this playlist" },
      url: "/playlists",
    });
    const playlist = created.json();
    await request(app, {
      method: "PUT",
      payload: { setIds: [set.id] },
      url: `/playlists/${playlist.id}/sets`,
    });

    const deleted = await request(app, {
      method: "DELETE",
      url: `/sets/${set.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual(set);
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json()).toEqual({ sets: [] });
    const playlistSets = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}`,
    });
    expect(playlistSets.json()).toEqual({ sets: [] });
    const playlists = await request(app, {
      method: "GET",
      url: "/playlists",
    });
    expect(playlists.json()).toEqual({ playlists: [playlist] });

    const missing = await request(app, {
      method: "DELETE",
      url: `/sets/${set.id}`,
    });
    expect(missing.statusCode).toBe(404);
  } finally {
    await app.dispose();
  }
});

test("rejects browser origins and non-loopback hosts before accessing the private library", async () => {
  const app = createApp();
  try {
    await Promise.all(
      [
        { origin: "https://untrusted.example" },
        { origin: "null" },
        { host: "untrusted.example" },
      ].map(async (headers) => {
        const response = await app.handler(
          new Request("http://127.0.0.1:4310/sets", { headers })
        );
        expect(response.status).toBe(403);
      })
    );
    const write = await request(app, {
      headers: { origin: "https://untrusted.example" },
      method: "POST",
      payload: {
        tags: [],
        title: "Unwanted",
        url: "https://soundcloud.com/dj/set",
      },
      url: "/sets",
    });
    expect(write.statusCode).toBe(403);
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toEqual([]);
  } finally {
    await app.dispose();
  }
});

test("keeps ordered playlists independent of each other and the saved library", async () => {
  const app = createApp();
  try {
    const savedFirst = await request(app, {
      method: "POST",
      payload: {
        tags: ["live"],
        title: "First",
        url: "https://youtu.be/abcdefghijk",
      },
      url: "/sets",
    });
    const first = savedFirst.json();
    const savedSecond = await request(app, {
      method: "POST",
      payload: {
        tags: [],
        title: "Second",
        url: "https://soundcloud.com/dj/night",
      },
      url: "/sets",
    });
    const second = savedSecond.json();
    const create = await request(app, {
      method: "POST",
      payload: { name: "Evenings" },
      url: "/playlists",
    });
    expect(create.statusCode).toBe(201);
    const playlist = create.json();
    const createdAnother = await request(app, {
      method: "POST",
      payload: { name: "Favorites" },
      url: "/playlists",
    });
    const another = createdAnother.json();
    const playlists = await request(app, { method: "GET", url: "/playlists" });
    expect(playlists.json().playlists).toHaveLength(2);
    const members = await request(app, {
      method: "PUT",
      payload: { setIds: [second.id, first.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(members.json()).toEqual({ sets: [second, first] });
    const anotherMembers = await request(app, {
      method: "PUT",
      payload: { setIds: [first.id] },
      url: `/playlists/${another.id}/sets`,
    });
    expect(anotherMembers.statusCode).toBe(200);
    const ordered = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}`,
    });
    expect(ordered.json()).toEqual({ sets: [second, first] });
    const tagged = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}&tag=live`,
    });
    expect(tagged.json()).toEqual({ sets: [first] });
    const reordered = await request(app, {
      method: "PUT",
      payload: { setIds: [first.id, second.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(reordered.json()).toEqual({ sets: [first, second] });
    const missingMember = await request(app, {
      method: "PUT",
      payload: { setIds: ["missing"] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(missingMember.statusCode).toBe(404);
    const duplicateMember = await request(app, {
      method: "PUT",
      payload: { setIds: [first.id, first.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(duplicateMember.statusCode).toBe(400);
    const unchanged = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}`,
    });
    expect(unchanged.json()).toEqual({ sets: [first, second] });
    const cleared = await request(app, {
      method: "PUT",
      payload: { setIds: [] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(cleared.json()).toEqual({ sets: [] });
    const independent = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${another.id}`,
    });
    expect(independent.json()).toEqual({ sets: [first] });
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toHaveLength(2);
  } finally {
    await app.dispose();
  }
});
