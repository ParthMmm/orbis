/* oxlint-disable no-await-in-loop -- The journey observes ordered WebSocket messages and cleans resources in reverse order. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NodeMessageSchema } from "@orbis/contracts/node";
import type { NodeMessage } from "@orbis/contracts/node";
import { Schema } from "effect";

import { startAudioNode } from "./audio-node.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for node");
    }
    await Bun.sleep(10);
  }
};

test("real node reconnects and handles duplicate download, details and release commands without a database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbis-node-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const fixture = path.join(directory, "fixture.mp3");
  const generated = Bun.spawn([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    fixture,
  ]);
  expect(await generated.exited).toBe(0);
  const runner = path.join(directory, "yt-dlp");
  await writeFile(
    runner,
    `#!/usr/bin/env python3\nimport sys, shutil, json\nif '--version' in sys.argv: print('fixture')\nelif '--dump-single-json' in sys.argv: print(json.dumps({'title':'Fixture', 'duration':1}))\nelse: shutil.copyfile(${JSON.stringify(fixture)},sys.argv[sys.argv.index('-o')+1])\n`,
    { mode: 0o755 }
  );
  const messages: NodeMessage[] = [];
  let socket: Bun.ServerWebSocket<undefined> | undefined;
  const server = Bun.serve({
    fetch(request, listener) {
      expect(request.headers.get("authorization")).toBe("Bearer node-secret");
      if (listener.upgrade(request)) {
        return;
      }
      return new Response(null, { status: 400 });
    },
    port: 0,
    websocket: {
      message(_ws, message) {
        messages.push(
          Schema.decodeUnknownSync(NodeMessageSchema)(
            JSON.parse(String(message))
          )
        );
      },
      open(ws) {
        socket = ws;
      },
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  const node = await startAudioNode({
    audioDir: path.join(directory, "audio"),
    groupUrl: `ws://localhost:${server.port}/api/node`,
    nodeKey: "node-secret",
    reconnectDelayMs: 10,
    ytdlpBin: runner,
  });
  cleanups.push(() => node.close());
  await until(() => messages.some((message) => message.kind === "inventory"));
  const start = {
    kind: "start",
    requestId: "run1",
    setId: "fixture",
    source: "youtube",
    url: "https://youtu.be/abcdefghijk",
  };
  socket?.send(JSON.stringify(start));
  socket?.send(JSON.stringify(start));
  await until(() => messages.some((message) => message.kind === "finished"));
  expect(messages.find((message) => message.kind === "finished")).toMatchObject(
    { format: "mp3", requestId: "run1", setId: "fixture" }
  );
  socket?.send(
    JSON.stringify({
      kind: "read-details",
      requestId: "details1",
      setId: "fixture",
      url: start.url,
    })
  );
  await until(() => messages.some((message) => message.kind === "details"));
  socket?.close();
  await until(
    () =>
      messages.filter((message) => message.kind === "inventory").length === 2
  );
  expect(
    messages.filter((message) => message.kind === "inventory")[1]
  ).toMatchObject({ files: [{ format: "mp3", setId: "fixture" }] });
  socket?.send(
    JSON.stringify({ kind: "release", requestId: "release1", setId: "fixture" })
  );
  await until(() => messages.some((message) => message.kind === "released"));
  expect(await readdir(path.join(directory, "audio"))).toEqual([]);
  const names = await readdir(directory);
  expect(names.some((name) => /sqlite|devices/u.test(name))).toBe(false);
});
