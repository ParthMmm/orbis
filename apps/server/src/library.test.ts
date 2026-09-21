import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "./library-limits.js";
import { request } from "./test-http.js";

const SEEDED_CREATED_AT = "2026-04-01T00:00:00.000Z";

type MembershipSeed = readonly [playlistIndex: number, setIndex: number];

const indexRange = (count: number) =>
  Array.from({ length: count }, (_, index) => index);

const seededVideoUrl = (index: number) =>
  `https://www.youtube.com/watch?v=${index.toString(36).padStart(11, "0")}`;

// Bulk fixtures exceed what a test can post one request at a time, so the app creates its own
// schema first and the rows are then written directly to that database file.
const seedDatabase = async (
  databasePath: string,
  seed: (database: Database) => void
) => {
  const app = createApp({ databasePath });
  try {
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.statusCode).toBe(200);
  } finally {
    await app.dispose();
  }
  const database = new Database(databasePath);
  try {
    database.transaction(() => seed(database))();
  } finally {
    database.close();
  }
};

const seedLibrary = async (
  databasePath: string,
  counts: { readonly playlists: number; readonly sets: number },
  memberships: readonly MembershipSeed[] = []
) => {
  const setIds = indexRange(counts.sets).map((index) => `seeded-set-${index}`);
  const playlistIds = indexRange(counts.playlists).map(
    (index) => `seeded-playlist-${index}`
  );
  await seedDatabase(databasePath, (database) => {
    const insertSet = database.query(
      "INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user) VALUES (?, ?, ?, ?, ?, ?, 1)"
    );
    for (const [index, id] of setIds.entries()) {
      insertSet.run(
        id,
        seededVideoUrl(index),
        `Seeded set ${index}`,
        "youtube",
        JSON.stringify([]),
        SEEDED_CREATED_AT
      );
    }
    const insertPlaylist = database.query(
      "INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)"
    );
    for (const [index, id] of playlistIds.entries()) {
      insertPlaylist.run(id, `Seeded playlist ${index}`, SEEDED_CREATED_AT);
    }
    const positions = new Map<string, number>();
    const insertMembership = database.query(
      "INSERT INTO playlist_sets (playlist_id, set_id, position) VALUES (?, ?, ?)"
    );
    for (const [playlistIndex, setIndex] of memberships) {
      const playlistId = playlistIds[playlistIndex] ?? "";
      const position = positions.get(playlistId) ?? 0;
      insertMembership.run(playlistId, setIds[setIndex] ?? "", position);
      positions.set(playlistId, position + 1);
    }
  });
  return { playlistIds, setIds };
};

const fill = (playlistIndex: number, setCount: number): MembershipSeed[] =>
  indexRange(setCount).map((setIndex) => [playlistIndex, setIndex] as const);

const membershipIds = async (
  app: ReturnType<typeof createApp>,
  setId: string
): Promise<string[]> => {
  const library = await request(app, { method: "GET", url: "/sets" });
  const set = library
    .json()
    .sets.find((each: { id: string }) => each.id === setId);
  return set.playlistIds;
};

test("keeps the two membership capacities separate", () => {
  expect(MAX_SETS_PER_PLAYLIST).toBe(500);
  expect(MAX_PLAYLISTS_PER_SET).toBe(100);
});

test("accepts a full Playlist list and rejects one id more", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: 1, sets: MAX_SETS_PER_PLAYLIST + 1 },
      fill(0, MAX_SETS_PER_PLAYLIST)
    );
    const app = createApp({ databasePath });
    try {
      const full = await request(app, {
        method: "PUT",
        payload: { setIds: setIds.slice(0, MAX_SETS_PER_PLAYLIST) },
        url: `/playlists/${playlistIds[0]}/sets`,
      });
      expect(full.statusCode).toBe(200);
      expect(full.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);

      const tooMany = await request(app, {
        method: "PUT",
        payload: { setIds },
        url: `/playlists/${playlistIds[0]}/sets`,
      });
      expect(tooMany.statusCode).toBe(400);

      const kept = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistIds[0] ?? ""}`,
      });
      expect(kept.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);
      expect(kept.json().sets.at(-1).id).toBe(
        setIds[MAX_SETS_PER_PLAYLIST - 1]
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("accepts a Set in its hundredth Playlist and rejects one id more", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: MAX_PLAYLISTS_PER_SET + 1, sets: 1 },
      indexRange(MAX_PLAYLISTS_PER_SET - 1).map(
        (playlistIndex) => [playlistIndex, 0] as const
      )
    );
    const setId = setIds[0] ?? "";
    const app = createApp({ databasePath });
    try {
      const hundredth = await request(app, {
        method: "PUT",
        payload: { playlistIds: playlistIds.slice(0, MAX_PLAYLISTS_PER_SET) },
        url: `/sets/${setId}/playlists`,
      });
      expect(hundredth.statusCode).toBe(200);
      expect(hundredth.json().playlistIds).toHaveLength(MAX_PLAYLISTS_PER_SET);

      const tooMany = await request(app, {
        method: "PUT",
        payload: { playlistIds },
        url: `/sets/${setId}/playlists`,
      });
      expect(tooMany.statusCode).toBe(400);
      expect(await membershipIds(app, setId)).toHaveLength(
        MAX_PLAYLISTS_PER_SET
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("keeps a Playlist full when a Set joins it through the Set-centric route", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: 1, sets: MAX_SETS_PER_PLAYLIST + 1 },
      fill(0, MAX_SETS_PER_PLAYLIST)
    );
    const playlistId = playlistIds[0] ?? "";
    const extraSetId = setIds[MAX_SETS_PER_PLAYLIST] ?? "";
    const app = createApp({ databasePath });
    try {
      const appended = await request(app, {
        method: "PUT",
        payload: { playlistIds: [playlistId] },
        url: `/sets/${extraSetId}/playlists`,
      });
      expect(appended.statusCode).toBe(400);
      expect(appended.json().message).toBe(
        "A playlist can hold at most 500 sets."
      );
      expect(await membershipIds(app, extraSetId)).toEqual([]);
      const kept = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistId}`,
      });
      expect(kept.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);
      expect(kept.json().sets.at(-1).id).toBe(
        setIds[MAX_SETS_PER_PLAYLIST - 1]
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("keeps a Set within its Playlist limit through the Playlist-centric route", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: MAX_PLAYLISTS_PER_SET + 1, sets: 1 },
      indexRange(MAX_PLAYLISTS_PER_SET).map(
        (playlistIndex) => [playlistIndex, 0] as const
      )
    );
    const setId = setIds[0] ?? "";
    const extraPlaylistId = playlistIds[MAX_PLAYLISTS_PER_SET] ?? "";
    const app = createApp({ databasePath });
    try {
      const joined = await request(app, {
        method: "PUT",
        payload: { setIds: [setId] },
        url: `/playlists/${extraPlaylistId}/sets`,
      });
      expect(joined.statusCode).toBe(400);
      expect(joined.json().message).toBe(
        "A set can belong to at most 100 playlists."
      );
      expect(await membershipIds(app, setId)).toHaveLength(
        MAX_PLAYLISTS_PER_SET
      );
      const joinedPlaylist = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${extraPlaylistId}`,
      });
      expect(joinedPlaylist.json().sets).toEqual([]);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("rejects a move into a full Playlist and keeps the source membership", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const movingSetIndex = MAX_SETS_PER_PLAYLIST + 1;
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: 3, sets: movingSetIndex + 1 },
      [[0, movingSetIndex] as const, ...fill(1, MAX_SETS_PER_PLAYLIST)]
    );
    const movingSetId = setIds[movingSetIndex] ?? "";
    const [sourceId = "", fullId = "", roomId = ""] = playlistIds;
    const app = createApp({ databasePath });
    try {
      // The Set states its whole membership, so naming a Playlist with room and a full one
      // would leave the source Playlist if the rejected half were applied first.
      const rejected = await request(app, {
        method: "PUT",
        payload: { playlistIds: [roomId, fullId] },
        url: `/sets/${movingSetId}/playlists`,
      });
      expect(rejected.statusCode).toBe(400);
      expect(await membershipIds(app, movingSetId)).toEqual([sourceId]);
      const room = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${roomId}`,
      });
      expect(room.json().sets).toEqual([]);
      const full = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${fullId}`,
      });
      expect(full.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("reorders a full Playlist and keeps its members at the limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: 1, sets: MAX_SETS_PER_PLAYLIST },
      fill(0, MAX_SETS_PER_PLAYLIST)
    );
    const playlistId = playlistIds[0] ?? "";
    // Move the first Set to the end: every member keeps a place, but none keeps its position.
    const [firstSetId = "", ...restSetIds] = setIds;
    const reorderedIds = [...restSetIds, firstSetId];
    const app = createApp({ databasePath });
    try {
      const reordered = await request(app, {
        method: "PUT",
        payload: { setIds: reorderedIds },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(reordered.statusCode).toBe(200);
      expect(
        reordered.json().sets.map((set: { id: string }) => set.id)
      ).toEqual(reorderedIds);

      const retried = await request(app, {
        method: "PUT",
        payload: { setIds: reorderedIds },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(retried.statusCode).toBe(200);
      const ordered = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistId}`,
      });
      expect(ordered.json().sets.map((set: { id: string }) => set.id)).toEqual(
        reorderedIds
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("keeps a Set in its hundredth Playlist across a swap", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: MAX_PLAYLISTS_PER_SET + 1, sets: 1 },
      indexRange(MAX_PLAYLISTS_PER_SET).map(
        (playlistIndex) => [playlistIndex, 0] as const
      )
    );
    const setId = setIds[0] ?? "";
    const app = createApp({ databasePath });
    try {
      const unchanged = await request(app, {
        method: "PUT",
        payload: { playlistIds: playlistIds.slice(0, MAX_PLAYLISTS_PER_SET) },
        url: `/sets/${setId}/playlists`,
      });
      expect(unchanged.statusCode).toBe(200);
      expect(unchanged.json().playlistIds).toHaveLength(MAX_PLAYLISTS_PER_SET);

      // Naming 100 Playlists while leaving one and joining one keeps the Set at its limit.
      const swapped = await request(app, {
        method: "PUT",
        payload: { playlistIds: playlistIds.slice(1) },
        url: `/sets/${setId}/playlists`,
      });
      expect(swapped.statusCode).toBe(200);
      expect(swapped.json().playlistIds).toHaveLength(MAX_PLAYLISTS_PER_SET);
      // The response sorts Playlist ids, so compare the membership itself.
      expect(new Set(swapped.json().playlistIds)).toEqual(
        new Set(playlistIds.slice(1))
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("removes membership at the limit without deleting Sets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: MAX_PLAYLISTS_PER_SET, sets: MAX_SETS_PER_PLAYLIST },
      [
        ...fill(0, MAX_SETS_PER_PLAYLIST),
        ...indexRange(MAX_PLAYLISTS_PER_SET - 1).map(
          (playlistIndex) => [playlistIndex + 1, 0] as const
        ),
      ]
    );
    const setId = setIds[0] ?? "";
    const playlistId = playlistIds[0] ?? "";
    const app = createApp({ databasePath });
    try {
      const filled = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistId}`,
      });
      expect(filled.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);
      expect(await membershipIds(app, setId)).toHaveLength(
        MAX_PLAYLISTS_PER_SET
      );

      const cleared = await request(app, {
        method: "PUT",
        payload: { setIds: [] },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toEqual({ sets: [] });

      const left = await request(app, {
        method: "PUT",
        payload: { playlistIds: [] },
        url: `/sets/${setId}/playlists`,
      });
      expect(left.statusCode).toBe(200);
      expect(left.json().playlistIds).toEqual([]);

      // Membership removal leaves the Sets themselves in the Library.
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);
      const playlists = await request(app, {
        method: "GET",
        url: "/playlists",
      });
      expect(playlists.json().playlists).toHaveLength(MAX_PLAYLISTS_PER_SET);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("keeps an oversized Playlist readable and lets it shrink", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const oversized = MAX_SETS_PER_PLAYLIST + 1;
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: 1, sets: oversized + 1 },
      fill(0, oversized)
    );
    const playlistId = playlistIds[0] ?? "";
    const extraSetId = setIds[oversized] ?? "";
    const app = createApp({ databasePath });
    try {
      const readable = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistId}`,
      });
      expect(readable.statusCode).toBe(200);
      expect(readable.json().sets).toHaveLength(oversized);

      // Growth stays refused while the data is oversized.
      const grown = await request(app, {
        method: "PUT",
        payload: { playlistIds: [playlistId] },
        url: `/sets/${extraSetId}/playlists`,
      });
      expect(grown.statusCode).toBe(400);
      expect(await membershipIds(app, extraSetId)).toEqual([]);

      // A list above the cap cannot be stated, so resubmitting it is not a recovery path.
      const restated = await request(app, {
        method: "PUT",
        payload: { setIds: setIds.slice(0, oversized) },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(restated.statusCode).toBe(400);

      const reduced = await request(app, {
        method: "PUT",
        payload: { setIds: setIds.slice(0, MAX_SETS_PER_PLAYLIST) },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(reduced.statusCode).toBe(200);
      expect(reduced.json().sets).toHaveLength(MAX_SETS_PER_PLAYLIST);

      const refused = await request(app, {
        method: "PUT",
        payload: { playlistIds: [playlistId] },
        url: `/sets/${extraSetId}/playlists`,
      });
      expect(refused.statusCode).toBe(400);

      // Nothing was trimmed on its own, and no Set was deleted.
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.json().sets).toHaveLength(oversized + 1);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("keeps an oversized Set membership readable and lets it shrink", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-test-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    const oversized = MAX_PLAYLISTS_PER_SET + 1;
    const { playlistIds, setIds } = await seedLibrary(
      databasePath,
      { playlists: oversized + 1, sets: 1 },
      indexRange(oversized).map((playlistIndex) => [playlistIndex, 0] as const)
    );
    const setId = setIds[0] ?? "";
    const unusedPlaylistId = playlistIds[oversized] ?? "";
    const app = createApp({ databasePath });
    try {
      const library = await request(app, { method: "GET", url: "/sets" });
      expect(library.json().sets[0].playlistIds).toHaveLength(oversized);

      const grown = await request(app, {
        method: "PUT",
        payload: { setIds: [setId] },
        url: `/playlists/${unusedPlaylistId}/sets`,
      });
      expect(grown.statusCode).toBe(400);
      expect(await membershipIds(app, setId)).toHaveLength(oversized);

      const reduced = await request(app, {
        method: "PUT",
        payload: { playlistIds: playlistIds.slice(0, MAX_PLAYLISTS_PER_SET) },
        url: `/sets/${setId}/playlists`,
      });
      expect(reduced.statusCode).toBe(200);
      expect(reduced.json().playlistIds).toHaveLength(MAX_PLAYLISTS_PER_SET);

      const removed = await request(app, {
        method: "PUT",
        payload: { playlistIds: [] },
        url: `/sets/${setId}/playlists`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().playlistIds).toEqual([]);

      const after = await request(app, { method: "GET", url: "/sets" });
      expect(after.json().sets).toHaveLength(1);
      const emptied = await request(app, {
        method: "GET",
        url: `/sets?playlistId=${playlistIds[0] ?? ""}`,
      });
      expect(emptied.json().sets).toEqual([]);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

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
    const withMember = await request(app, { method: "GET", url: "/playlists" });
    // The sidebar shows this number without asking once per playlist, so it has to track
    // membership on its own.
    expect(withMember.json().playlists[0].setCount).toBe(1);

    const deleted = await request(app, {
      method: "DELETE",
      url: `/sets/${set.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ...set, playlistIds: [playlist.id] });
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
    expect(members.json()).toEqual({
      sets: [
        { ...second, playlistIds: [playlist.id] },
        { ...first, playlistIds: [playlist.id] },
      ],
    });
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
    expect(ordered.json()).toEqual({
      sets: [
        { ...second, playlistIds: [playlist.id] },
        { ...first, playlistIds: expect.arrayContaining([playlist.id]) },
      ],
    });
    const tagged = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}&tag=live`,
    });
    expect(tagged.json()).toEqual({
      sets: [{ ...first, playlistIds: expect.arrayContaining([playlist.id]) }],
    });
    const reordered = await request(app, {
      method: "PUT",
      payload: { setIds: [first.id, second.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(reordered.json()).toEqual({
      sets: [
        { ...first, playlistIds: expect.arrayContaining([playlist.id]) },
        { ...second, playlistIds: [playlist.id] },
      ],
    });
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
    expect(unchanged.json()).toEqual({
      sets: [
        { ...first, playlistIds: expect.arrayContaining([playlist.id]) },
        { ...second, playlistIds: [playlist.id] },
      ],
    });
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
    expect(independent.json()).toEqual({
      sets: [{ ...first, playlistIds: expect.arrayContaining([another.id]) }],
    });
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toHaveLength(2);
  } finally {
    await app.dispose();
  }
});

test("states a Set's Playlists in one request and lets it leave them", async () => {
  const app = createApp();
  try {
    const created = await request(app, {
      method: "POST",
      payload: {
        tags: [],
        title: "Movable",
        url: "https://youtu.be/abcdefghijk",
      },
      url: "/sets",
    });
    const set = created.json();
    const evenResponse = await request(app, {
      method: "POST",
      payload: { name: "Evenings" },
      url: "/playlists",
    });
    const even = evenResponse.json();
    const lateResponse = await request(app, {
      method: "POST",
      payload: { name: "Late" },
      url: "/playlists",
    });
    const late = lateResponse.json();

    const joined = await request(app, {
      method: "PUT",
      payload: { playlistIds: [even.id] },
      url: `/sets/${set.id}/playlists`,
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({ ...set, playlistIds: [even.id] });

    // The caller states the membership it wants, so naming another Playlist is a move rather
    // than a second membership, and the one it left does not keep a phantom row.
    const moved = await request(app, {
      method: "PUT",
      payload: { playlistIds: [late.id] },
      url: `/sets/${set.id}/playlists`,
    });
    expect(moved.json()).toEqual({ ...set, playlistIds: [late.id] });
    const inLate = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${late.id}`,
    });
    expect(inLate.json().sets.map((each: { id: string }) => each.id)).toEqual([
      set.id,
    ]);
    const inEven = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${even.id}`,
    });
    expect(inEven.json()).toEqual({ sets: [] });

    const left = await request(app, {
      method: "PUT",
      payload: { playlistIds: [] },
      url: `/sets/${set.id}/playlists`,
    });
    expect(left.json()).toEqual({ ...set, playlistIds: [] });

    const missingSet = await request(app, {
      method: "PUT",
      payload: { playlistIds: [even.id] },
      url: "/sets/missing/playlists",
    });
    expect(missingSet.statusCode).toBe(404);
    const missingPlaylist = await request(app, {
      method: "PUT",
      payload: { playlistIds: ["missing"] },
      url: `/sets/${set.id}/playlists`,
    });
    expect(missingPlaylist.statusCode).toBe(404);
    const twice = await request(app, {
      method: "PUT",
      payload: { playlistIds: [even.id, even.id] },
      url: `/sets/${set.id}/playlists`,
    });
    expect(twice.statusCode).toBe(400);
  } finally {
    await app.dispose();
  }
});

test("creates a Playlist with a unique name and rejects a duplicate", async () => {
  const app = createApp();
  try {
    const created = await request(app, {
      method: "POST",
      payload: { name: "Evenings" },
      url: "/playlists",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Evenings",
      setCount: 0,
    });

    const duplicate = await request(app, {
      method: "POST",
      payload: { name: "evenings" },
      url: "/playlists",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toBe(
      "A playlist with this name already exists."
    );

    const blank = await request(app, {
      method: "POST",
      payload: { name: "   " },
      url: "/playlists",
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().message).toBe("Enter a playlist name.");
  } finally {
    await app.dispose();
  }
});

test("renames and deletes a Playlist while preserving its Sets", async () => {
  const app = createApp();
  try {
    const playlist = (
      await request(app, {
        method: "POST",
        payload: { name: "Evenings" },
        url: "/playlists",
      })
    ).json();
    const set = (
      await request(app, {
        method: "POST",
        payload: {
          tags: [],
          title: "Night session",
          url: "https://youtu.be/abcdefghijk",
        },
        url: "/sets",
      })
    ).json();
    await request(app, {
      method: "PUT",
      payload: { setIds: [set.id] },
      url: `/playlists/${playlist.id}/sets`,
    });

    const renamed = await request(app, {
      method: "PATCH",
      payload: { name: "Late nights" },
      url: `/playlists/${playlist.id}`,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: playlist.id,
      name: "Late nights",
      setCount: 1,
    });

    const conflict = await request(app, {
      method: "POST",
      payload: { name: "Other" },
      url: "/playlists",
    });
    const other = conflict.json();
    const taken = await request(app, {
      method: "PATCH",
      payload: { name: "Other" },
      url: `/playlists/${playlist.id}`,
    });
    expect(taken.statusCode).toBe(409);

    const deleted = await request(app, {
      method: "DELETE",
      url: `/playlists/${playlist.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      id: playlist.id,
      name: "Late nights",
      setCount: 1,
    });

    const lists = await request(app, { method: "GET", url: "/playlists" });
    expect(lists.json().playlists.map((each: { id: string }) => each.id)).toEqual(
      [other.id]
    );
    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toHaveLength(1);
    expect(library.json().sets[0].playlistIds).toEqual([]);
  } finally {
    await app.dispose();
  }
});

test("persists Playlist order across membership writes and removal", async () => {
  const app = createApp();
  try {
    const playlist = (
      await request(app, {
        method: "POST",
        payload: { name: "Evenings" },
        url: "/playlists",
      })
    ).json();
    const first = (
      await request(app, {
        method: "POST",
        payload: {
          tags: [],
          title: "First",
          url: "https://youtu.be/aaaaaaaaaaa",
        },
        url: "/sets",
      })
    ).json();
    const second = (
      await request(app, {
        method: "POST",
        payload: {
          tags: [],
          title: "Second",
          url: "https://youtu.be/bbbbbbbbbbb",
        },
        url: "/sets",
      })
    ).json();
    const third = (
      await request(app, {
        method: "POST",
        payload: {
          tags: [],
          title: "Third",
          url: "https://youtu.be/ccccccccccc",
        },
        url: "/sets",
      })
    ).json();

    const added = await request(app, {
      method: "PUT",
      payload: { setIds: [first.id, second.id, third.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(added.json().sets.map((each: { id: string }) => each.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    const reordered = await request(app, {
      method: "PUT",
      payload: { setIds: [third.id, first.id, second.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(reordered.json().sets.map((each: { title: string }) => each.title)).toEqual(
      ["Third", "First", "Second"]
    );

    const listed = await request(app, {
      method: "GET",
      url: `/sets?playlistId=${playlist.id}`,
    });
    expect(listed.json().sets.map((each: { id: string }) => each.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);

    const removed = await request(app, {
      method: "PUT",
      payload: { setIds: [third.id, second.id] },
      url: `/playlists/${playlist.id}/sets`,
    });
    expect(removed.json().sets.map((each: { id: string }) => each.id)).toEqual([
      third.id,
      second.id,
    ]);

    const library = await request(app, { method: "GET", url: "/sets" });
    expect(library.json().sets).toHaveLength(3);
    expect(
      library.json().sets.find((each: { id: string }) => each.id === first.id)
        .playlistIds
    ).toEqual([]);
  } finally {
    await app.dispose();
  }
});
