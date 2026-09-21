import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import {
  addToQueue,
  complete,
  play,
  ready,
  savedSet,
  seedSets,
  withSeededApp,
} from "./test-library.js";

/**
 * A Listen is an activation, not a press: the Set that is active holds the open Listen, and a
 * Finish is that Listen reaching the end of the Set. So the signals a client sends are judged
 * against the stored state, which is what makes a retried one do nothing.
 */
test("becoming the active Set counts one Listen and dates it", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const unheard = await savedSet(app, "a");
    expect(unheard.listenCount).toBe(0);
    expect(unheard.lastListenedAt).toBeNull();

    await play(app, "a");

    const listened = await savedSet(app, "a");
    expect(listened.listenCount).toBe(1);
    expect(listened.lastListenedAt).not.toBeNull();
    expect(listened.finishCount).toBe(0);
  });
});

test("pausing and resuming the active Set leaves the Listen count alone", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await play(app, "a");
    }

    const read1 = await savedSet(app, "a");
    expect(read1.listenCount).toBe(1);
  });
});

test("a Set that becomes active again after another one counts a second Listen", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await play(app, "b");
    await play(app, "a");

    const read2 = await savedSet(app, "a");
    expect(read2.listenCount).toBe(2);
    const read3 = await savedSet(app, "b");
    expect(read3.listenCount).toBe(1);
  });
});

test("automatic queue advancement counts one Listen for the Set that takes over", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    const read4 = await savedSet(app, "b");
    expect(read4.listenCount).toBe(0);

    await complete(app, "a");

    const read5 = await savedSet(app, "b");
    expect(read5.listenCount).toBe(1);
  });
});

test("a Listen that reaches the natural end counts one Finish", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    await play(app, "a");
    await complete(app, "a");

    const finished = await savedSet(app, "a");
    expect(finished.listenCount).toBe(1);
    expect(finished.finishCount).toBe(1);
  });
});

test("replaying after a finish counts a second Listen and leaves one Finish", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    await play(app, "a");
    await complete(app, "a");
    await play(app, "a");

    const replayed = await savedSet(app, "a");
    expect(replayed.listenCount).toBe(2);
    expect(replayed.finishCount).toBe(1);
  });
});

test("a duplicate completion signal adds no Finish", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    await play(app, "a");
    await complete(app, "a");
    await complete(app, "a");
    await complete(app, "a");

    const read6 = await savedSet(app, "a");
    expect(read6.finishCount).toBe(1);
  });
});

test("a completion repeated from another device leaves both counters alone", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    // The other device reports the same completion a moment later, after this one advanced the
    // queue. It names a Set that is no longer active, so nothing is counted twice.
    await complete(app, "a");
    await complete(app, "a");

    const advanced = await savedSet(app, "b");
    expect(advanced.listenCount).toBe(1);
    expect(advanced.finishCount).toBe(0);
    const finished = await savedSet(app, "a");
    expect(finished.listenCount).toBe(1);
    expect(finished.finishCount).toBe(1);
  });
});

test("a stopped Set keeps its Listen open without counting a second one", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    // Stopping early is the client's own act: it reports no completion. Playing the same Set
    // again is the same Listen, so the count does not move.
    await play(app, "a");

    const stopped = await savedSet(app, "a");
    expect(stopped.listenCount).toBe(1);
    expect(stopped.finishCount).toBe(0);
  });
});

test("the counters survive a restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-stats-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedSets(databasePath, ready(["a", "b"]));
    const first = createApp({ databasePath });
    await play(first, "a");
    await addToQueue(first, "b");
    await complete(first, "a");
    await first.dispose();

    const second = createApp({ databasePath });
    try {
      const finished = await savedSet(second, "a");
      expect(finished.listenCount).toBe(1);
      expect(finished.finishCount).toBe(1);
      const advanced = await savedSet(second, "b");
      expect(advanced.listenCount).toBe(1);
      expect(advanced.lastListenedAt).not.toBeNull();
    } finally {
      await second.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
