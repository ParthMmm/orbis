import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WideEvent } from "evlog";

import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";

const youTubeUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";

// The identifying line is at the start; the generic cookie hint is the long tail.
const longYtdlpStderr = `ERROR: [youtube] aqzKEbpKQAA: Sign in to confirm you're not a bot. ${"x".repeat(400)}`;

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
                stderr: longYtdlpStderr,
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
    // The identifying line is at the start of stderr, beyond the logged tail.
    expect(logs).toContain("Sign in to confirm");
    expect(logs).toContain('"stderrHead"');
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

const cobaltFailures = [
  {
    kind: "timeout",
    name: "timeout",
    reason: "Cobalt did not answer in time.",
    response: () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
  },
  {
    kind: "transport",
    name: "transport",
    reason: "Cobalt could not be reached.",
    response: () => Promise.reject(new TypeError("network failed")),
  },
  {
    code: "link.unsupported",
    kind: "http",
    name: "http",
    reason: "Cobalt refused the download request.",
    response: () =>
      Promise.resolve(
        Response.json(
          { error: { code: "link.unsupported" }, status: "error" },
          { status: 429 }
        )
      ),
    status: 429,
  },
  {
    code: "link.unsupported",
    kind: "provider",
    name: "provider",
    reason: "Cobalt could not fetch this audio.",
    response: () =>
      Promise.resolve(
        Response.json({ error: { code: "link.unsupported" }, status: "error" })
      ),
    status: 200,
  },
  {
    kind: "malformed",
    name: "malformed",
    reason: "Cobalt sent a malformed response.",
    response: () => Promise.resolve(new Response("{", { status: 200 })),
    status: 200,
  },
  {
    kind: "malformed",
    name: "invalid-shape",
    reason: "Cobalt sent a malformed response.",
    response: () =>
      Promise.resolve(Response.json({ status: "tunnel", url: 42 })),
    status: 200,
  },
  {
    code: "cobalt_error_unknown",
    kind: "provider",
    name: "unsafe-code",
    reason: "Cobalt could not fetch this audio.",
    response: () =>
      Promise.resolve(
        Response.json({
          error: { code: "link.unsupported\nApi-Key secret" },
          status: "error",
        })
      ),
    status: 200,
  },
];

for (const scenario of cobaltFailures) {
  test(`Cobalt ${scenario.name} failure keeps its cause in the download event`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orbis-cobalt-errors-"));
    const events: WideEvent[] = [];
    const app = createApp({
      audio: {
        audioDir: path.join(root, "audio"),
        cobaltApiKey: "private-key",
        cobaltUrl: "http://cobalt.test/",
        fetch: () => scenario.response(),
        startWorker: true,
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
      expect(saved.statusCode).toBe(201);
      // SAFETY: the successful save route returns the stored Set's id.
      const id = saved.json().id as string;
      await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
      await waitForJob(events, Date.now() + 10_000);
      const jobs = events.filter((event) => event.job === "audio-download");
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job).toMatchObject({
        outcome: "failure",
        reason: scenario.reason,
      });
      const logs = JSON.stringify(job?.logs);
      expect(logs).toContain(`"cobaltFailure":"${scenario.kind}"`);
      if (scenario.status !== undefined) {
        expect(logs).toContain(`"cobaltStatus":${scenario.status}`);
      }
      if (scenario.code !== undefined) {
        expect(logs).toContain(`"cobaltProviderCode":"${scenario.code}"`);
      }
      expect(JSON.stringify(job)).not.toContain("private-key");
      expect(JSON.stringify(job)).not.toContain("Api-Key secret");
      const artifact = path.join(process.cwd(), ".cache", "cobalt-errors");
      await mkdir(artifact, { recursive: true });
      await writeFile(
        path.join(artifact, `${scenario.name}.json`),
        `${JSON.stringify({ job, scenario: scenario.name }, null, 2)}\n`
      );
    } finally {
      await app.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
}
