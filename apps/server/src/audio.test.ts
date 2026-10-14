import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AudioOptions } from "./audio.js";
import { createTestApp as createApp, storedKey } from "./test-app.js";
import { request } from "./test-http.js";

const youTubeUrl = "https://www.youtube.com/watch?v=aqzKEbpKQAA";
const haveFfmpeg =
  Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
const testFfmpeg = haveFfmpeg ? test : test.skip;

interface CobaltProbeBody {
  readonly url?: string;
}

interface StubHandlers {
  cobalt: (body: CobaltProbeBody) => Response;
  tunnel: (url: string, signal: AbortSignal) => Response | Promise<Response>;
}

interface AudioStateResponse {
  readonly bytesReceived?: number;
  readonly bytesTotal?: number | null;
  readonly format?: string | null;
  readonly state: string;
}

const defaultTunnel = (_url: string) =>
  new Response("not stubbed", { status: 500 });

const stubFetch =
  (handlers: StubHandlers) =>
  (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (target.startsWith("http://cobalt.test/")) {
      // SAFETY: the stub only reads url for routing; the worker Schema-decodes the rest.
      const body = JSON.parse(String(init?.body)) as CobaltProbeBody;
      return Promise.resolve(handlers.cobalt(body));
    }
    // SAFETY: route handlers always pass a signal; the stub forwards it to paced tunnels.
    const signal = init?.signal as AbortSignal;
    return Promise.resolve(handlers.tunnel(target, signal));
  };

const setUp = async (
  handlers: StubHandlers,
  audioOptions: AudioOptions = {}
) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-audio-"));
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: [],
      people: [
        { autoDownload: false, id: "host", removed: false, username: "host" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "test-key",
      cobaltUrl: "http://cobalt.test/",
      fetch: stubFetch(handlers),
      startWorker: true,
      ...audioOptions,
    },
    databasePath: path.join(root, "library.sqlite"),
  });
  return {
    app,
    cleanup: async () => {
      await app.dispose();
      await rm(root, { force: true, recursive: true });
    },
    root,
  };
};

const seedSet = async (
  app: ReturnType<typeof createApp>,
  url: string = youTubeUrl
) => {
  const saved = await request(app, {
    method: "POST",
    payload: { tags: [], title: "Seeded set", url },
    url: "/sets",
  });
  expect(saved.statusCode).toBe(201);
  // SAFETY: the save route returns the stored set including its id.
  return saved.json().id as string;
};

const rawRequest = (
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  accessMode = "device" as const,
  authenticated = true
) => {
  if (authenticated) {
    headers["x-orbis-test-auth"] = "fixture";
  }
  return app.handler(
    new Request(`http://127.0.0.1:4310${url}`, { headers, method }),
    accessMode
  );
};

const waitForState = async (
  app: ReturnType<typeof createApp>,
  id: string,
  wanted: readonly string[],
  deadline: number = Date.now() + 10_000
): Promise<AudioStateResponse> => {
  const state = await request(app, {
    method: "GET",
    url: `/sets/${id}/audio/state`,
  });
  expect(state.statusCode).toBe(200);
  const body = state.json();
  if (wanted.includes(body.state)) {
    return body;
  }
  if (Date.now() > deadline) {
    throw new Error(
      `state never reached ${wanted.join("/")} (last: ${body.state})`
    );
  }
  await Bun.sleep(25);
  return waitForState(app, id, wanted, deadline);
};

// Response needs an exact ArrayBuffer; a Uint8Array view over a pool would over-read.
const responseBytes = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy.buffer);
};

const tunnelOk = (bytes: Uint8Array) => (_url: string) => {
  const body = responseBytes(bytes);
  body.headers.set("content-length", String(bytes.length));
  return body;
};

const makeSineMp3 = (fixture: string) => {
  const proc = Bun.spawnSync([
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
    "-b:a",
    "128k",
    fixture,
  ]);
  expect(proc.exitCode).toBe(0);
};

test("requesting audio without cobalt configured is a 503", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-audio-"));
  const app = createApp({
    audio: { audioDir: path.join(root, "audio") },
    databasePath: path.join(root, "library.sqlite"),
  });
  try {
    const id = await seedSet(app);
    const response = await request(app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(response.statusCode).toBe(503);
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("a download request queues and re-requesting answers the current state", async () => {
  const { app, cleanup } = await setUp({
    cobalt: () => new Response("{}", { status: 500 }),
    tunnel: defaultTunnel,
  });
  try {
    const id = await seedSet(app);
    const first = await request(app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().downloadState).toBe("queued");
    const second = await request(app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(second.statusCode).toBe(200);
    expect(
      ["queued", "downloading"].includes(second.json().downloadState)
    ).toBe(true);
    const failed = await waitForState(app, id, ["failed"]);
    expect(failed.state).toBe("failed");
  } finally {
    await cleanup();
  }
});

test("a stored mp3 downloads to ready and streams with ranges", async () => {
  if (!haveFfmpeg) {
    return;
  }
  const fixture = path.join(tmpdir(), `orbis-mp3-${crypto.randomUUID()}.mp3`);
  makeSineMp3(fixture);
  const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer());
  const { app, cleanup, root } = await setUp({
    cobalt: () => Response.json({ status: "tunnel", url: "http://cdn.test/a" }),
    tunnel: tunnelOk(bytes),
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    const done = await waitForState(app, id, ["ready"]);
    expect(done.format).toBe("mp3");
    expect(done.bytesReceived).toBe(bytes.length);
    const file = await rawRequest(app, "GET", `/sets/${id}/audio`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("audio/mpeg");
    expect(file.headers.get("accept-ranges")).toBe("bytes");
    const full = await file.arrayBuffer();
    expect(full.byteLength).toBe(bytes.length);
    const part = await rawRequest(app, "GET", `/sets/${id}/audio`, {
      range: "bytes=0-99",
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 0-99/${bytes.length}`
    );
    const partBytes = await part.arrayBuffer();
    expect(partBytes.byteLength).toBe(100);
    const bad = await rawRequest(app, "GET", `/sets/${id}/audio`, {
      range: `bytes=${bytes.length}-`,
    });
    expect(bad.status).toBe(416);
    const audioFiles = await Array.fromAsync(
      new Bun.Glob("*.mp3").scan(path.join(root, "audio"))
    );
    expect(audioFiles.length).toBe(1);
  } finally {
    await cleanup();
    await rm(fixture, { force: true });
  }
});

testFfmpeg("a webm delivery remuxes to ogg without re-encoding", async () => {
  const fixture = path.join(tmpdir(), `orbis-webm-${crypto.randomUUID()}.webm`);
  const proc = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:a",
    "libopus",
    fixture,
  ]);
  expect(proc.exitCode).toBe(0);
  const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer());
  const { app, cleanup, root } = await setUp({
    cobalt: () => Response.json({ status: "tunnel", url: "http://cdn.test/a" }),
    tunnel: tunnelOk(bytes),
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    const done = await waitForState(app, id, ["ready"]);
    expect(done.format).toBe("ogg");
    const stored = Bun.file(path.join(root, "audio", `${id}.ogg`));
    expect(await stored.exists()).toBe(true);
    const probe = Bun.spawnSync([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=format_name",
      "-of",
      "csv=p=0",
      path.join(root, "audio", `${id}.ogg`),
    ]);
    expect(probe.stdout.toString().trim()).toBe("ogg");
    const file = await rawRequest(app, "GET", `/sets/${id}/audio`);
    expect(file.headers.get("content-type")).toBe("audio/ogg");
  } finally {
    await cleanup();
    await rm(fixture, { force: true });
  }
});

test("a cobalt error lands the set in failed with no partial file", async () => {
  const { app, cleanup, root } = await setUp({
    cobalt: () =>
      Response.json({ error: { code: "link.unsupported" }, status: "error" }),
    tunnel: defaultTunnel,
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id, ["failed"]);
    const leftovers = await Array.fromAsync(
      new Bun.Glob("*").scan(path.join(root, "audio"))
    );
    expect(leftovers.length).toBe(0);
    const missing = await rawRequest(app, "GET", `/sets/${id}/audio`);
    expect(missing.status).toBe(404);
  } finally {
    await cleanup();
  }
});

test("canceling mid-flight returns to none with no files", async () => {
  const { app, cleanup, root } = await setUp({
    cobalt: () => Response.json({ status: "tunnel", url: "http://cdn.test/a" }),
    tunnel: (_url) => {
      const stream = new ReadableStream({
        async start(controller) {
          for (let index = 0; index < 40; index += 1) {
            // eslint-disable-next-line no-await-in-loop
            await Bun.sleep(50);
            controller.enqueue(new Uint8Array(1024));
          }
          controller.close();
        },
      });
      return new Response(stream);
    },
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id, ["downloading"]);
    const canceled = await request(app, {
      method: "DELETE",
      url: `/sets/${id}/audio/download`,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().downloadState).toBe("none");
    const leftovers = await Array.fromAsync(
      new Bun.Glob("*").scan(path.join(root, "audio"))
    );
    expect(leftovers.length).toBe(0);
  } finally {
    await cleanup();
  }
});

test("a download requested again after a cancel is still worked on", async () => {
  let attempts = 0;
  const { app, cleanup } = await setUp({
    cobalt: () => Response.json({ status: "tunnel", url: "http://cdn.test/a" }),
    tunnel: (_url, signal) => {
      attempts += 1;
      if (attempts > 1) {
        return new Response("gone", { status: 500 });
      }
      const stream = new ReadableStream({
        async start(controller) {
          signal.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
          for (let index = 0; index < 40 && !signal.aborted; index += 1) {
            // eslint-disable-next-line no-await-in-loop
            await Bun.sleep(50);
            if (!signal.aborted) {
              controller.enqueue(new Uint8Array(1024));
            }
          }
        },
      });
      return new Response(stream);
    },
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id, ["downloading"]);
    await request(app, { method: "DELETE", url: `/sets/${id}/audio/download` });
    const again = await request(app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(again.json().downloadState).toBe("queued");
    const settled = await waitForState(app, id, ["failed", "ready"]);
    expect(settled.state).toBe("failed");
  } finally {
    await cleanup();
  }
});

test("deleting a ready download is a conflict", async () => {
  if (!haveFfmpeg) {
    return;
  }
  const fixture = path.join(tmpdir(), `orbis-mp3-${crypto.randomUUID()}.mp3`);
  makeSineMp3(fixture);
  const bytes = new Uint8Array(await Bun.file(fixture).arrayBuffer());
  const { app, cleanup } = await setUp({
    cobalt: () => Response.json({ status: "tunnel", url: "http://cdn.test/a" }),
    tunnel: tunnelOk(bytes),
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id, ["ready"]);
    const kept = await request(app, {
      method: "DELETE",
      url: `/sets/${id}/audio/download`,
    });
    expect(kept.statusCode).toBe(400);
  } finally {
    await cleanup();
    await rm(fixture, { force: true });
  }
});

test("a restart re-queues a download stuck mid-flight", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-audio-"));
  const databasePath = path.join(root, "library.sqlite");
  const boot = createApp({ databasePath });
  const saved = await request(boot, {
    method: "POST",
    payload: { tags: [], title: "Seeded set", url: youTubeUrl },
    url: "/sets",
  });
  await boot.dispose();
  const { Database } = await import("bun:sqlite");
  const database = new Database(databasePath);
  // SAFETY: the save route returns the stored set including its id.
  const savedId = saved.json().id as string;
  database
    .query("UPDATE sets SET download_state = 'downloading' WHERE id = ?")
    .run(savedId);
  database.close();
  const app = createApp({
    audio: { audioDir: path.join(root, "audio"), startWorker: false },
    databasePath,
  });
  try {
    const state = await request(app, {
      method: "GET",
      url: `/sets/${savedId}/audio/state`,
    });
    expect(state.json().state).toBe("queued");
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("device ingress without a token is rejected on every audio route", async () => {
  const { app, cleanup } = await setUp({
    cobalt: () => new Response("{}", { status: 500 }),
    tunnel: defaultTunnel,
  });
  try {
    const id = await seedSet(app);
    const routes = [
      ["POST", `/sets/${id}/audio/download`],
      ["GET", `/sets/${id}/audio/state`],
      ["GET", `/sets/${id}/audio`],
      ["DELETE", `/sets/${id}/audio/download`],
    ] as const;
    for (const [method, url] of routes) {
      // eslint-disable-next-line no-await-in-loop
      const response = await rawRequest(app, method, url, {}, "device", false);
      expect(response.status).toBe(403);
    }
  } finally {
    await cleanup();
  }
});

test("retrying a failed download queues it again", async () => {
  let attempts = 0;
  const { app, cleanup } = await setUp({
    cobalt: () => {
      attempts += 1;
      if (attempts === 1) {
        return Response.json({ error: "fetch.fail", status: "error" });
      }
      return Response.json({ status: "tunnel", url: "http://cdn.test/a" });
    },
    tunnel: tunnelOk(new Uint8Array([1, 2, 3, 4])),
  });
  try {
    const id = await seedSet(app);
    await request(app, { method: "POST", url: `/sets/${id}/audio/download` });
    await waitForState(app, id, ["failed"]);
    const retry = await request(app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().downloadState).toBe("queued");
    if (haveFfmpeg) {
      await waitForState(app, id, ["ready", "failed"]);
    }
  } finally {
    await cleanup();
  }
});

test("audio for a set that never downloaded is a 404", async () => {
  const { app, cleanup } = await setUp({
    cobalt: () => new Response("{}", { status: 500 }),
    tunnel: defaultTunnel,
  });
  try {
    const id = await seedSet(app);
    const missing = await rawRequest(app, "GET", `/sets/${id}/audio`);
    expect(missing.status).toBe(404);
    const state = await request(app, {
      method: "GET",
      url: "/sets/nope/audio/state",
    });
    expect(state.statusCode).toBe(404);
  } finally {
    await cleanup();
  }
});

test("only the Person who asked for a Download, or the Host, can cancel it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-audio-"));
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: [
        storedKey("ann-phone", "ann", "ann-key", "daily"),
        storedKey("bob-phone", "bob", "bob-key", "daily"),
      ],
      people: ["host", "ann", "bob"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: true,
        username: id,
      })),
      version: 2,
    })
  );
  const app = createApp({
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "test-key",
      cobaltUrl: "http://cobalt.test/",
      startWorker: false,
    },
    databasePath: path.join(root, "library.sqlite"),
  });
  const shared = { tags: [], title: "Shared set", url: youTubeUrl };
  const as = (key: string | undefined, method: string, url: string) =>
    request(app, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      method,
      payload: method === "POST" && url === "/sets" ? shared : undefined,
      url,
    });
  try {
    const saved = await as("ann-key", "POST", "/sets");
    expect(saved.statusCode).toBe(201);
    // SAFETY: the save route returns the stored set including its id.
    const id = saved.json().id as string;
    const bobSaved = await as("bob-key", "POST", "/sets");
    expect(bobSaved.statusCode).toBe(201);
    const asked = await as("ann-key", "POST", `/sets/${id}/audio/download`);
    expect(asked.statusCode).toBe(202);

    const other = await as("bob-key", "DELETE", `/sets/${id}/audio/download`);
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({
      message:
        "Only the Person who asked for this Download, or the Host, can cancel it.",
    });
    const still = await as("bob-key", "GET", `/sets/${id}/audio/state`);
    expect(still.json().state).toBe("queued");

    const own = await as("ann-key", "DELETE", `/sets/${id}/audio/download`);
    expect(own.statusCode).toBe(200);
    expect(own.json().downloadState).toBe("none");

    const askedAgain = await as(
      "bob-key",
      "POST",
      `/sets/${id}/audio/download`
    );
    expect(askedAgain.statusCode).toBe(202);
    const host = await as(undefined, "DELETE", `/sets/${id}/audio/download`);
    expect(host.statusCode).toBe(200);
    expect(host.json().downloadState).toBe("none");
  } finally {
    await app.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
