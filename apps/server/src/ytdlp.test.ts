import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createApp } from "./app.js";
import { request } from "./test-http.js";
import type { YtdlpRunner } from "./ytdlp.js";
import { Ytdlp, ytdlpArgs } from "./ytdlp.js";

const bin = "/opt/yt-dlp/yt-dlp";
const hostileUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";
const youTubeUrl = hostileUrl;
const soundCloudUrl = "https://soundcloud.com/artist/track";
const haveFfmpeg =
  Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
const testFfmpeg = haveFfmpeg ? test : test.skip;

// The worker runs on its own fiber, so the tests poll for a terminal state.
const waitForState = async (
  app: ReturnType<typeof createApp>,
  id: string,
  deadline: number = Date.now() + 10_000
): Promise<string> => {
  const state = await request(app, {
    method: "GET",
    url: `/sets/${id}/audio/state`,
  });
  const current: string = state.json().state;
  if (current === "ready" || current === "failed" || Date.now() > deadline) {
    return current;
  }
  await Bun.sleep(25);
  return waitForState(app, id, deadline);
};

const outputOf = (argv: readonly string[]) => {
  const index = argv.indexOf("-o");
  return argv[index + 1] ?? "";
};

const download = (
  run: YtdlpRunner,
  destination: string,
  url: string = youTubeUrl,
  ytdlpCookies: string | null = null
) =>
  Effect.runPromise(
    Effect.gen(function* runDownload() {
      const ytdlp = yield* Ytdlp;
      yield* ytdlp.download(
        url,
        destination,
        () => {
          // Progress is not asserted here.
        },
        new AbortController().signal
      );
    }).pipe(
      Effect.provide(
        Ytdlp.layer({
          ytdlpBin: bin,
          ytdlpCookies: ytdlpCookies ?? undefined,
          ytdlpRun: run,
        })
      )
    )
  );

test("the argument list is fixed and the URL follows --", () => {
  const url = "--exec=touch /tmp/pwned";
  const argv = ytdlpArgs(bin, "/m/a.part", url);
  expect(argv[0]).toBe(bin);
  expect(argv.at(-2)).toBe("--");
  expect(argv.at(-1)).toBe(url);
  expect(argv.slice(argv.indexOf("-f"), argv.indexOf("-f") + 2)).toEqual([
    "-f",
    "bestaudio",
  ]);
  expect(argv).not.toContain("--cookies");
  expect(ytdlpArgs(bin, "/m/a.part", url, "/c.txt")).toContain("--cookies");
  const clientArgv = ytdlpArgs(
    bin,
    "/m/a.part",
    url,
    undefined,
    "web_embedded"
  );
  expect(clientArgv[clientArgv.indexOf("--extractor-args") + 1]).toBe(
    "youtube:player_client=web_embedded"
  );
  expect(clientArgv.indexOf("--extractor-args")).toBeLessThan(
    clientArgv.indexOf("--")
  );
});

test("a failed run deletes the partial file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const destination = path.join(root, "a.part");
  const run: YtdlpRunner = async (argv) => {
    if (argv.includes("--version")) {
      return { code: 0, stdout: "2026.09.01\n" };
    }
    await Bun.write(outputOf(argv), "half a file");
    return { code: 1, stdout: "" };
  };
  try {
    await expect(download(run, destination)).rejects.toBeDefined();
    expect(await Bun.file(destination).exists()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a YouTube sign-in challenge retries with the web_embedded client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const destination = path.join(root, "a.part");
  const calls: (readonly string[])[] = [];
  const run: YtdlpRunner = async (argv) => {
    if (argv.includes("--version")) {
      return { code: 0, stdout: "x" };
    }
    calls.push(argv);
    if (!argv.includes("--extractor-args")) {
      return {
        code: 1,
        stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot.",
        stdout: "",
      };
    }
    await Bun.write(outputOf(argv), "audio");
    return { code: 0, stdout: "" };
  };
  try {
    await download(run, destination);
    expect(calls.length).toBe(2);
    const [, retry] = calls;
    expect(calls[0]).not.toContain("--extractor-args");
    expect(retry?.[retry.indexOf("--extractor-args") + 1]).toBe(
      "youtube:player_client=web_embedded"
    );
    expect(await Bun.file(destination).text()).toBe("audio");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a SoundCloud failure gets no YouTube client retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const destination = path.join(root, "a.part");
  const calls: (readonly string[])[] = [];
  const run: YtdlpRunner = (argv) => {
    if (argv.includes("--version")) {
      return Promise.resolve({ code: 0, stdout: "x" });
    }
    calls.push(argv);
    return Promise.resolve({ code: 1, stdout: "" });
  };
  try {
    await expect(
      download(run, destination, soundCloudUrl)
    ).rejects.toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("--extractor-args");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("cookies are tried only after the anonymous attempts fail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const destination = path.join(root, "a.part");
  const calls: (readonly string[])[] = [];
  const run: YtdlpRunner = async (argv) => {
    if (argv.includes("--version")) {
      return { code: 0, stdout: "x" };
    }
    calls.push(argv);
    if (!argv.includes("--cookies")) {
      return { code: 1, stdout: "" };
    }
    await Bun.write(outputOf(argv), "audio");
    return { code: 0, stdout: "" };
  };
  try {
    await download(run, destination, youTubeUrl, "/c.txt");
    expect(calls.length).toBe(3);
    expect(calls[0]).not.toContain("--cookies");
    expect(calls[0]).not.toContain("--extractor-args");
    expect(calls[1]).not.toContain("--cookies");
    expect(calls[1]).toContain("--extractor-args");
    expect(calls[2]).toContain("--cookies");
    expect(await Bun.file(destination).exists()).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// Both backends fail, so the call order alone shows which one went first.
const orderFor = async (url: string) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const calls: string[] = [];
  const app = createApp({
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "k",
      cobaltUrl: "http://cobalt.test/",
      fetch: (target) => {
        calls.push(
          String(target).startsWith("http://cobalt.test/") ? "cobalt" : "tunnel"
        );
        return Promise.resolve(new Response("{}", { status: 500 }));
      },
      startWorker: true,
      ytdlpBin: bin,
      ytdlpRun: (argv) => {
        if (!argv.includes("--version")) {
          calls.push("ytdlp");
        }
        return Promise.resolve({ code: 1, stdout: "" });
      },
    },
    databasePath: path.join(root, "library.sqlite"),
  });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: { tags: [], title: "Seeded set", url },
      url: "/sets",
    });
    // SAFETY: the save route returns the stored set including its id.
    const id = saved.json().id as string;
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id);
    return calls;
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
};

test("YouTube tries yt-dlp first and SoundCloud tries Cobalt first", async () => {
  // The YouTube yt-dlp attempt retries with the alternate client before Cobalt.
  expect(await orderFor(youTubeUrl)).toEqual(["ytdlp", "ytdlp", "cobalt"]);
  expect(await orderFor(soundCloudUrl)).toEqual(["cobalt", "ytdlp"]);
});

testFfmpeg(
  "a failed yt-dlp run falls back to Cobalt and stores the file",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
    const fixture = path.join(root, "sine.mp3");
    const made = Bun.spawnSync([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libmp3lame",
      fixture,
    ]);
    expect(made.exitCode).toBe(0);
    const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer());
    const app = createApp({
      audio: {
        audioDir: path.join(root, "audio"),
        cobaltApiKey: "k",
        cobaltUrl: "http://cobalt.test/",
        fetch: (target) =>
          Promise.resolve(
            String(target).startsWith("http://cobalt.test/")
              ? Response.json({ status: "tunnel", url: "http://cdn.test/a" })
              : new Response(new Uint8Array(bytes).buffer)
          ),
        startWorker: true,
        ytdlpBin: bin,
        ytdlpRun: () => Promise.resolve({ code: 1, stdout: "" }),
      },
      databasePath: path.join(root, "library.sqlite"),
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
      const state = await waitForState(app, id);
      expect(state).toBe("ready");
    } finally {
      await app.dispose();
      await rm(root, { force: true, recursive: true });
    }
  }
);

test("the download lands at the destination although yt-dlp strips a .part name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-ytdlp-"));
  const destination = path.join(root, "a.part");
  // Real yt-dlp writes `-o x.part` to `x`: it treats `.part` as its own suffix.
  const run: YtdlpRunner = async (argv) => {
    if (argv.includes("--version")) {
      return { code: 0, stdout: "2026.08.19\n" };
    }
    await Bun.write(outputOf(argv).replace(/\.part$/u, ""), "audio bytes");
    return { code: 0, stdout: "" };
  };
  try {
    await download(run, destination);
    expect(await Bun.file(destination).text()).toBe("audio bytes");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
