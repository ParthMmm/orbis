import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { request } from "./test-http.js";
import {
  addToQueue,
  complete,
  messageIn,
  order,
  play,
  playNext,
  putPosition,
  queueOf,
  ready,
  seedSets,
  SET_SECONDS,
  withSeededApp,
} from "./test-library.js";

test("the queue starts empty with nothing active", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    expect(await queueOf(app)).toEqual({ activeSetId: null, entries: [] });
  });
});

test("tapping a playable Set makes it active and keeps the queue behind it", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "b");
    await addToQueue(app, "c");

    const { queue, response } = await play(app, "a");

    expect(response.statusCode).toBe(200);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

test("a Set already in the queue takes the active place without moving", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "c");

    const { queue } = await play(app, "c");

    expect(queue.activeSetId).toBe("c");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

test("a queued action with nothing playing queues the Set and starts nothing", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await playNext(app, "a");
    await addToQueue(app, "b");

    const queue = await queueOf(app);
    expect(queue.activeSetId).toBeNull();
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("Play Next inserts directly after the active Set", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await playNext(app, "c");
    await playNext(app, "b");

    expect(await order(app)).toEqual(["a", "b", "c"]);
    const queue = await queueOf(app);
    expect(queue.activeSetId).toBe("a");
  });
});

test("Add to Queue appends", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "c");

    expect(await order(app)).toEqual(["a", "b", "c"]);
  });
});

test("Play Next moves a Set that is already queued", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "c");
    await playNext(app, "c");

    expect(await order(app)).toEqual(["a", "c", "b"]);
  });
});

test("a queued action on the active Set leaves the queue alone", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "a");
    await playNext(app, "a");

    const queue = await queueOf(app);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("playing a Playlist replaces the queue in Playlist order, with its playable members only", async () => {
  await withSeededApp(
    [...ready(["a", "b", "c"]), { downloadState: "none", id: "d" }],
    async (app) => {
      const created = await request(app, {
        method: "POST",
        payload: { name: "Closing sets" },
        url: "/playlists",
      });
      expect(created.statusCode).toBe(201);
      const { id: playlistId } = created.json();
      const members = await request(app, {
        method: "PUT",
        payload: { setIds: ["c", "a", "d", "b"] },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(members.statusCode).toBe(200);
      await play(app, "b");

      const replaced = await request(app, {
        method: "PUT",
        payload: { playlistId },
        url: "/queue/playlist",
      });

      expect(replaced.statusCode).toBe(200);
      // SAFETY: the route answers with the whole queue, which is asserted by field here.
      const queue = replaced.json().queue as {
        activeSetId: string | null;
        entries: { id: string }[];
      };
      expect(queue.entries.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
      expect(queue.activeSetId).toBe("c");
    }
  );
});

test("playing a Playlist that does not exist is refused", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const response = await request(app, {
      method: "PUT",
      payload: { playlistId: "no-such-playlist" },
      url: "/queue/playlist",
    });

    expect(response.statusCode).toBe(404);
  });
});

test("a Set without Retained Audio cannot enter the queue", async () => {
  await withSeededApp([{ downloadState: "none", id: "d" }], async (app) => {
    const activated = await play(app, "d");
    expect(activated.response.statusCode).toBe(400);
    expect(messageIn(activated.response)).toBe(
      "Only sets with audio can be added to the queue."
    );
    const queued = await addToQueue(app, "d");
    expect(queued.response.statusCode).toBe(400);
    expect(await queueOf(app)).toEqual({ activeSetId: null, entries: [] });
  });
});

test("a Set that is not in the library is refused", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const activated = await play(app, "missing");
    const queued = await addToQueue(app, "missing");

    expect(activated.response.statusCode).toBe(404);
    expect(queued.response.statusCode).toBe(404);
  });
});

test("a Download state other than ready cannot enter the queue", async () => {
  await withSeededApp(
    [
      { downloadState: "downloading", id: "a" },
      { downloadState: "failed", id: "b" },
      { downloadState: "queued", id: "c" },
    ],
    async (app) => {
      const attempts = await Promise.all(
        ["a", "b", "c"].map((id) => play(app, id))
      );

      for (const attempt of attempts) {
        expect(attempt.response.statusCode).toBe(400);
      }
    }
  );
});

test("completion removes the finished Set, resets its position, and starts the next", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await putPosition(app, "a", 120);

    const { queue, response } = await complete(app, "a");

    expect(response.statusCode).toBe(200);
    expect(queue.entries.map((entry) => entry.id)).toEqual(["b"]);
    expect(queue.activeSetId).toBe("b");
    const sets = await request(app, { method: "GET", url: "/sets" });
    const finished = sets
      .json()
      .sets.find((set: { id: string }) => set.id === "a");
    expect(finished.playbackPositionSeconds).toBe(0);
  });
});

test("an empty queue stops with nothing active", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    await play(app, "a");
    await complete(app, "a");

    expect(await queueOf(app)).toEqual({ activeSetId: null, entries: [] });
  });
});

test("a completion for a Set that is not active leaves the queue alone", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await putPosition(app, "b", 60);

    const { queue, response } = await complete(app, "b");

    expect(response.statusCode).toBe(200);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("removing a Set removes its queue entry", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");

    const removed = await request(app, { method: "DELETE", url: "/sets/a" });

    expect(removed.statusCode).toBe(200);
    expect(await order(app)).toEqual(["b"]);
  });
});

test("a Playback Position is stored as whole seconds", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "a", 62.6);

    expect(reported.response.statusCode).toBe(200);
    expect(reported.set.playbackPositionSeconds).toBe(63);
  });
});

test("a Playback Position past the end of the Set is stored as the end", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "a", SET_SECONDS + 500);

    expect(reported.response.statusCode).toBe(200);
    expect(reported.set.playbackPositionSeconds).toBe(SET_SECONDS);
  });
});

test("a negative Playback Position is refused", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "a", -1);

    expect(reported.response.statusCode).toBe(400);
  });
});

test("a Playback Position for a Set that is not in the library is refused", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "missing", 10);

    expect(reported.response.statusCode).toBe(404);
  });
});

test("the queue keeps its order and its active Set across a restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-queue-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedSets(databasePath, ready(["a", "b", "c"]));
    const first = createApp({ databasePath });
    await play(first, "b");
    await playNext(first, "c");
    await first.dispose();

    const second = createApp({ databasePath });
    try {
      const queue = await queueOf(second);
      expect(queue.activeSetId).toBe("b");
      expect(queue.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
    } finally {
      await second.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
