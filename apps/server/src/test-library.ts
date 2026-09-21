import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SavedSet } from "@orbis/contracts";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

export const SET_SECONDS = 600;
const CREATED_AT = "2026-04-01T00:00:00.000Z";

export type App = ReturnType<typeof createApp>;
export type Response = Awaited<ReturnType<typeof request>>;

export interface Queue {
  activeSetId: string | null;
  entries: SavedSet[];
}

export interface SetSeed {
  readonly downloadState?: string;
  readonly id: string;
}

/**
 * Sets are written straight into the database because the queue admits only Sets with Retained
 * Audio, and Retained Audio comes from a Download that needs Cobalt and ffmpeg. The subject here
 * is what the Queue and Stats do with a Set, not how the Set came to have audio.
 */
export const seedSets = async (
  databasePath: string,
  seeds: readonly SetSeed[]
) => {
  const app = createApp({ databasePath });
  try {
    const health = await request(app, { method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  } finally {
    await app.dispose();
  }
  const database = new Database(databasePath);
  try {
    database.run("PRAGMA foreign_keys = ON");
    const insertSet = database.query(
      `INSERT INTO sets
        (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
        VALUES (?, ?, ?, 'youtube', '[]', ?, 1, ?, ?)`
    );
    for (const [index, seed] of seeds.entries()) {
      insertSet.run(
        seed.id,
        `https://www.youtube.com/watch?v=${seed.id.padEnd(11, "x")}`,
        `Set ${seed.id}`,
        CREATED_AT,
        seed.downloadState ?? "ready",
        SET_SECONDS + index
      );
    }
  } finally {
    database.close();
  }
};

/** The Sets the queue can hold, all with Retained Audio. */
export const ready = (ids: readonly string[]): SetSeed[] =>
  ids.map((id) => ({ downloadState: "ready", id }));

export const withSeededApp = async (
  seeds: readonly SetSeed[],
  run: (app: App) => Promise<void>
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-queue-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedSets(databasePath, seeds);
    const app = createApp({ databasePath });
    try {
      await run(app);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

/** The queue a response carried. Every queue route answers with the whole queue. */
const queueIn = (response: Response): Queue =>
  // SAFETY: the queue contract is { queue: { activeSetId, entries: SavedSet[] } }, which the
  // tests then assert field by field.
  response.json().queue as Queue;

/** The sentence a refused request carried. */
export const messageIn = (response: Response): string =>
  // SAFETY: a refusal answers with { message } from the application's failure response.
  response.json().message as string;

/** The Set a response carried. */
export const setIn = (response: Response): SavedSet =>
  // SAFETY: the Set routes answer with the SavedSet contract, which the tests read by field.
  response.json() as SavedSet;

export const queueOf = async (app: App): Promise<Queue> => {
  const response = await request(app, { method: "GET", url: "/queue" });
  expect(response.statusCode).toBe(200);
  return queueIn(response);
};

export const order = async (app: App) => {
  const queue = await queueOf(app);
  return queue.entries.map((entry) => entry.id);
};

export const play = async (app: App, setId: string) => {
  const response = await request(app, {
    method: "PUT",
    payload: { setId },
    url: "/queue/active",
  });
  return { queue: queueIn(response), response };
};

export const queueEntry = async (
  app: App,
  setId: string,
  placement: "next" | "end"
) => {
  const response = await request(app, {
    method: "POST",
    payload: { placement, setId },
    url: "/queue/entries",
  });
  return { queue: queueIn(response), response };
};

export const playNext = (app: App, setId: string) =>
  queueEntry(app, setId, "next");

export const addToQueue = (app: App, setId: string) =>
  queueEntry(app, setId, "end");

export const complete = async (app: App, setId: string) => {
  const response = await request(app, {
    method: "POST",
    payload: { setId },
    url: "/queue/completion",
  });
  return { queue: queueIn(response), response };
};

export const putPosition = async (app: App, setId: string, seconds: number) => {
  const response = await request(app, {
    method: "PUT",
    payload: { seconds },
    url: `/sets/${setId}/position`,
  });
  return { response, set: setIn(response) };
};

export const setsInLibrary = async (app: App): Promise<SavedSet[]> => {
  const response = await request(app, { method: "GET", url: "/sets" });
  expect(response.statusCode).toBe(200);
  // SAFETY: the library route answers with the SavedSet contract, read here by field.
  return (response.json().sets as SavedSet[]) ?? [];
};

export const savedSet = async (app: App, id: string): Promise<SavedSet> => {
  const sets = await setsInLibrary(app);
  const found = sets.find((set) => set.id === id);
  expect(found).toBeDefined();
  // SAFETY: the expectation above fails the test when the Set is missing.
  return found as SavedSet;
};
