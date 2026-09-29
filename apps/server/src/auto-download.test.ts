/* oxlint-disable no-await-in-loop -- Ordered saves exercise the queue's capacity boundary. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { startListeners } from "./listeners.js";

const Saved = Schema.Struct({
  autoDownloadResult: Schema.String,
  downloadState: Schema.String,
  id: Schema.String,
});
const Person = Schema.Struct({
  autoDownload: Schema.Boolean,
  id: Schema.String,
});
const AudioState = Schema.Struct({ state: Schema.String });
const evidence = path.resolve(import.meta.dir, "../../../.cache/auto-download");
const failures = [
  "new Person defaults off",
  "settings do not persist across devices and restart",
  "saving never queues audio",
  "ready or running audio starts twice",
  "queue capacity makes save fail",
  "another Person inherits the setting",
];

type Payload = { autoDownload: boolean } | { title: string; url: string };
const fixture = async (startWorker: boolean, hold = false) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-auto-download-"));
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["a1", "a2", "b1"].map((id) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: id[0],
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b"].map((id) => ({
        id,
        removed: false,
        username: id,
      })),
      version: 2,
    })
  );
  let jobs = 0;
  const release = Promise.withResolvers<undefined>();
  if (!hold) {
    release.resolve();
  }
  const backend = Bun.serve({
    async fetch(request) {
      if (new URL(request.url).pathname === "/audio") {
        return new Response(
          Bun.file(
            path.resolve(
              import.meta.dir,
              "../../../scripts/fixtures/ready-set.m4a"
            )
          )
        );
      }
      jobs += 1;
      await release.promise;
      return Response.json({
        status: "tunnel",
        url: new URL("/audio", request.url).href,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const open = () =>
    startListeners(
      createApp({
        audio: {
          audioDir: path.join(root, "audio"),
          cobaltApiKey: "test",
          cobaltUrl: backend.url.href,
          startWorker,
        },
        databasePath: path.join(root, "library.sqlite"),
        logging: { silent: true },
      }),
      { devicePort: 0, localPort: 0 }
    );
  let listeners = await open();
  const send = (
    key: string,
    route: string,
    method = "GET",
    payload?: Payload,
    userAgent = "Orbis test"
  ) => {
    if (!listeners.device) {
      throw new Error("Missing device listener");
    }
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": userAgent,
      },
      method,
    };
    if (payload) {
      init.body = JSON.stringify(payload);
    }
    return fetch(new URL(route, listeners.device.url), init);
  };
  const me = async (key: string) => {
    const response = await send(key, "/me");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return Schema.decodeUnknownSync(Person)(body);
  };
  const save = async (key: string, number: number, userAgent?: string) => {
    const response = await send(
      key,
      "/sets",
      "POST",
      {
        title: `Auto ${number}`,
        url: `https://www.youtube.com/watch?v=auto${String(number).padStart(7, "0")}`,
      },
      userAgent
    );
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    return Schema.decodeUnknownSync(Saved)(body);
  };
  const state = async (key: string, id: string) => {
    const response = await send(key, `/sets/${id}/audio/state`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return Schema.decodeUnknownSync(AudioState)(body).state;
  };
  const ready = async (key: string, id: string) => {
    const deadline = Date.now() + 10_000;
    while ((await state(key, id)) !== "ready") {
      if (Date.now() > deadline) {
        throw new Error("Auto Download did not become playable");
      }
      await Bun.sleep(20);
    }
  };
  return {
    jobs: () => jobs,
    me,
    ready,
    release: () => release.resolve(),
    restart: async () => {
      await listeners.stop();
      listeners = await open();
    },
    save,
    send,
    state,
    stop: async () => {
      release.resolve();
      await listeners.stop();
      await backend.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
};

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

test("Auto Download defaults on and follows the Person across clients and restart", async () => {
  const lane = await fixture(true);
  try {
    const initial = await lane.me("a1");
    expect(initial.autoDownload).toBe(true);
    const on = await lane.save("a1", 1, "Raycast");
    expect(on).toMatchObject({
      autoDownloadResult: "queued",
      downloadState: "queued",
    });
    await lane.ready("a1", on.id);
    const audio = await lane.send("a2", `/sets/${on.id}/audio`);
    expect(audio.status).toBe(200);
    const audioBytes = await audio.arrayBuffer();
    expect(audioBytes.byteLength).toBeGreaterThan(0);
    const changed = await lane.send("a1", "/me", "PATCH", {
      autoDownload: false,
    });
    expect(changed.status).toBe(200);
    const secondDevice = await lane.me("a2");
    expect(secondDevice.autoDownload).toBe(false);
    const otherPerson = await lane.me("b1");
    expect(otherPerson.autoDownload).toBe(true);
    await lane.restart();
    const restarted = await lane.me("a2");
    expect(restarted.autoDownload).toBe(false);
    const off = await lane.save("a2", 2, "Orbis Share Extension");
    expect(off).toMatchObject({
      autoDownloadResult: "disabled",
      downloadState: "none",
    });
    const enabled = await lane.send("a2", "/me", "PATCH", {
      autoDownload: true,
    });
    expect(enabled.status).toBe(200);
    const shared = await lane.save("a1", 3, "Orbis Share Extension");
    expect(shared.autoDownloadResult).toBe("queued");
    await lane.ready("a1", shared.id);
    await record("clients-and-setting", {
      backendJobs: lane.jobs(),
      becamePlayable: true,
      off,
      on,
      shared,
    });
  } finally {
    await lane.stop();
  }
}, 20_000);

test("saving shared ready or running audio starts no second Download", async () => {
  const lane = await fixture(true, true);
  try {
    const first = await lane.save("a1", 10);
    expect(first.autoDownloadResult).toBe("queued");
    const running = await lane.save("b1", 10);
    expect(running.id).toBe(first.id);
    expect(running.autoDownloadResult).toBe("inProgress");
    lane.release();
    await lane.ready("a1", first.id);
    const readyFirst = await lane.save("a1", 11);
    await lane.ready("a1", readyFirst.id);
    const readySecond = await lane.save("b1", 11);
    expect(readySecond).toMatchObject({
      autoDownloadResult: "ready",
      downloadState: "ready",
      id: readyFirst.id,
    });
    expect(lane.jobs()).toBe(2);
    await record("shared-audio", {
      backendJobs: lane.jobs(),
      readySecond,
      running,
    });
  } finally {
    await lane.stop();
  }
}, 20_000);

test("the 20-job cap preserves a successful save with an explicit outcome", async () => {
  const lane = await fixture(false);
  try {
    for (let i = 0; i < 20; i += 1) {
      const saved = await lane.save("a1", 100 + i);
      expect(saved.autoDownloadResult).toBe("queued");
    }
    const full = await lane.save("a2", 120);
    expect(full).toMatchObject({
      autoDownloadResult: "queueFull",
      downloadState: "none",
    });
    expect(await lane.state("a1", full.id)).toBe("none");
    const other = await lane.save("b1", 121);
    expect(other.autoDownloadResult).toBe("queued");
    await record("queue-capacity", { full, other, waiting: 20 });
  } finally {
    await lane.stop();
  }
}, 20_000);
