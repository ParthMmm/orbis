import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WideEvent } from "evlog";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

const youTubeUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";

// The worker runs on its own fiber, so the test polls for the job's event.
const waitForJob = async (
  events: readonly WideEvent[],
  deadline: number
): Promise<void> => {
  if (
    events.some((event) => event.job === "audio-download") ||
    Date.now() > deadline
  ) {
    return;
  }
  await Bun.sleep(25);
  return waitForJob(events, deadline);
};

// The failure from 2026-09-29: yt-dlp exits with an error and Cobalt's tunnel answers
// 200 with no bytes. One event per download must name both causes.
test("a failed download emits one event that names each backend's cause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-events-"));
  const events: WideEvent[] = [];
  const app = createApp({
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "k",
      cobaltUrl: "http://cobalt.test/",
      fetch: (target) =>
        Promise.resolve(
          String(target).startsWith("http://cobalt.test/")
            ? Response.json({ status: "tunnel", url: "http://cdn.test/a" })
            : new Response(new Uint8Array(0), {
                headers: { "content-length": "0" },
              })
        ),
      startWorker: true,
      ytdlpBin: "/opt/yt-dlp/yt-dlp",
      ytdlpRun: (argv) =>
        Promise.resolve(
          argv.includes("--version")
            ? { code: 0, stdout: "2026.08.19\n" }
            : {
                code: 1,
                stderr: "ERROR: [youtube] aqzKEbpKQAA: Sign in to confirm",
                stdout: "",
              }
        ),
    },
    databasePath: path.join(root, "library.sqlite"),
    logging: { onEvent: (event) => events.push(event), silent: true },
  });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: { tags: [], title: "Seeded set", url: youTubeUrl },
      url: "/sets",
    });
    // SAFETY: the save route returns the stored set including its id.
    const id = saved.json().id as string;
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForJob(events, Date.now() + 10_000);

    const jobs = events.filter((event) => event.job === "audio-download");
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job).toMatchObject({
      level: "error",
      outcome: "failure",
      reason: "Cobalt sent an empty stream.",
      set: id,
      source: "youtube",
    });
    const logs = JSON.stringify(job?.logs);
    expect(logs).toContain("Sign in to confirm");
    expect(logs).toContain('"message":"cobalt tunnel opened"');
    expect(logs).toContain('"backend":"cobalt","bytes":0');
    const state = await request(app, {
      method: "GET",
      url: `/sets/${id}/audio/state`,
    });
    expect(state.json().state).toBe("failed");
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
