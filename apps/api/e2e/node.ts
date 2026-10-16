import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { SaveSetInput } from "@orbis/contracts";
import { AudioStateSchema, SavedSetSchema } from "@orbis/contracts/http-api";
/* oxlint-disable no-await-in-loop -- Ordered HTTP requests define queue fairness and capacity; polling waits for observed state. */
/* oxlint-disable unicorn/no-await-expression-member -- HTTP assertions read each completed response in place. */
import type { NodeCommand, NodeMessage } from "@orbis/contracts/node";
import { NodeCommandSchema } from "@orbis/contracts/node";
import { Schema } from "effect";
import { Miniflare } from "miniflare";

import { issueStreamGrant } from "../../server/src/stream-grant-core.js";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/audio-node",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "node-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const probe = Bun.serve({ fetch: () => new Response(), port: 0 });
const nodePort = probe.port;
await probe.stop(true);
const groupLog: string[] = [];
const runtimeOptions = {
  bindings: {
    AUDIO_NODE_URL: `http://127.0.0.1:${nodePort}`,
    STREAM_GRANT_SECRET: "11".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  handleStructuredLogs: ({ message }: { message: string }) => {
    groupLog.push(message);
  },
  modules: true,
  script: await output.text(),
};
let runtime = new Miniflare(runtimeOptions);
const transcript: unknown[] = [];
const request = (
  route: string,
  method = "GET",
  body?: SaveSetInput,
  token = "client-token"
) =>
  runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
  });
const AudioEvent = Schema.Struct({
  audio: Schema.Record(Schema.String, Schema.Unknown),
  ingress: Schema.optional(Schema.String),
  status: Schema.Number,
});
/** The wide events, from captured process output, that record an audio request. */
const audioEvents = (lines: readonly string[]) =>
  lines
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.includes('"audio":'))
    .map((line) => Schema.decodeUnknownSync(AudioEvent)(JSON.parse(line)));
const until = async <T>(
  read: () => Promise<T> | T,
  matches: (value: T) => boolean
): Promise<T> => {
  const deadline = Date.now() + 10_000;
  while (true) {
    const value = await read();
    if (matches(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${JSON.stringify(value)}`);
    }
    await Bun.sleep(20);
  }
};
const connect = async (
  files: Extract<NodeMessage, { kind: "inventory" }>["files"] = []
) => {
  const response = await runtime.dispatchFetch("http://orbis/api/node", {
    headers: { Upgrade: "websocket", authorization: "Bearer node-token" },
  });
  assert.equal(response.status, 101, await response.text());
  const socket = response.webSocket;
  assert.ok(socket);
  const commands: NodeCommand[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    const command = Schema.decodeUnknownSync(NodeCommandSchema)(
      JSON.parse(String(event.data))
    );
    commands.push(command);
    transcript.push(command);
  });
  const send = (message: NodeMessage) => {
    transcript.push(message);
    socket.send(JSON.stringify(message));
  };
  send({ files, kind: "inventory" });
  return { commands, send, socket };
};
const save = async (suffix: string, token = "client-token") => {
  const response = await request(
    "/sets",
    "POST",
    {
      tags: [],
      title: suffix,
      url: `https://soundcloud.com/fixture/${suffix}`,
    },
    token
  );
  assert.equal(response.status, 201, await response.clone().text());
  return Schema.decodeUnknownSync(SavedSetSchema)(await response.json());
};
const state = async (id: string) =>
  Schema.decodeUnknownSync(AudioStateSchema)(
    await (await request(`/sets/${id}/audio/state`)).json()
  );
try {
  assert.equal((await request("/__seed-node")).status, 200);
  assert.equal(
    (await request("/sets", "GET", undefined, "node-token")).status,
    403
  );
  assert.equal((await request("/node")).status, 403);
  const node = await connect();
  const set = await save("first");
  const start = await until(
    () =>
      node.commands.find(
        (command) => command.kind === "start" && command.setId === set.id
      ),
    (value) => value !== undefined
  );
  assert.ok(start);
  node.send({
    kind: "progress",
    received: 125,
    requestId: start.requestId,
    setId: set.id,
    total: 500,
  });
  await until(
    () => state(set.id),
    (value) => value.bytesReceived === 125
  );
  const finished = {
    bytes: 500,
    durationSeconds: 2,
    format: "mp3",
    kind: "finished",
    requestId: start.requestId,
    setId: set.id,
  } as const;
  node.send(finished);
  node.send(finished);
  const read = await until(
    () =>
      node.commands.find(
        (command) => command.kind === "read-details" && command.setId === set.id
      ),
    (value) => value !== undefined
  );
  assert.ok(read);
  const details = {
    chapters: [],
    creator: "fixture",
    creatorId: null,
    creatorUrl: null,
    description: "details fixture",
    durationSeconds: 2,
    genre: null,
    releasedAt: null,
    tags: ["fixture"],
    thumbnailUrl: null,
    title: "Fixture details",
  };
  node.send({
    details,
    kind: "details",
    requestId: read.requestId,
    setId: set.id,
  });
  node.send({
    details,
    kind: "details",
    requestId: read.requestId,
    setId: set.id,
  });
  await until(
    async () =>
      Schema.decodeUnknownSync(Schema.Struct({ details_state: Schema.String }))(
        await (await request(`/__node-set?id=${set.id}`)).json()
      ),
    (value) => value.details_state === "filled"
  );
  await until(
    () => state(set.id),
    (value) => value.state === "ready"
  );
  const second = await save("second");
  const failed = await until(
    () =>
      node.commands.find(
        (command) => command.kind === "start" && command.setId === second.id
      ),
    (value) => value !== undefined
  );
  assert.ok(failed);
  node.send({
    kind: "failed",
    reason: "fixture failure",
    requestId: failed.requestId,
    setId: second.id,
  });
  await until(
    () => state(second.id),
    (value) => value.state === "failed"
  );
  await request(`/sets/${second.id}/audio/download`, "POST");
  const retry = await until(
    () =>
      node.commands.find(
        (command) =>
          command.kind === "start" &&
          command.setId === second.id &&
          command.requestId !== failed.requestId
      ),
    (value) => value !== undefined
  );
  assert.ok(retry);
  assert.equal(
    (await request(`/sets/${second.id}/audio/download`, "DELETE")).status,
    200
  );
  await until(
    () =>
      node.commands.some(
        (command) => command.kind === "cancel" && command.setId === second.id
      ),
    Boolean
  );
  node.send({ ...finished, requestId: retry.requestId, setId: second.id });
  await Bun.sleep(50);
  assert.equal((await state(second.id)).state, "none");
  node.socket.close();
  const reconnected = await connect([
    { bytes: 25, durationSeconds: 1, format: "mp3", setId: "orphan" },
  ]);
  await until(
    () => state(set.id),
    (value) => value.state === "none"
  );
  await until(
    () =>
      reconnected.commands.some(
        (command) => command.kind === "release" && command.setId === "orphan"
      ),
    Boolean
  );
  await request(`/sets/${set.id}/audio/download`, "POST");
  const again = await until(
    () =>
      reconnected.commands.find(
        (command) => command.kind === "start" && command.setId === set.id
      ),
    (value) => value !== undefined
  );
  assert.ok(again);
  reconnected.send({ ...finished, requestId: again.requestId });
  await until(
    () => state(set.id),
    (value) => value.state === "ready"
  );
  await request(`/sets/${set.id}`, "DELETE");
  const release = await until(
    () =>
      reconnected.commands.find(
        (command) => command.kind === "release" && command.setId === set.id
      ),
    (value) => value !== undefined
  );
  assert.ok(release);
  reconnected.send({
    kind: "released",
    requestId: release.requestId,
    setId: set.id,
  });
  reconnected.send({
    kind: "released",
    requestId: release.requestId,
    setId: set.id,
  });
  reconnected.socket.close();
  await Bun.sleep(30);
  const queued: { id: string }[] = [];
  for (let index = 0; index < 21; index += 1) {
    queued.push(await save(`limit-${index}`));
  }
  const overflow = queued.at(20);
  assert.ok(overflow);
  assert.equal(
    (await request(`/sets/${overflow.id}/audio/download`, "POST")).status,
    429
  );
  const peerSet = await save("peer-job", "peer-token");
  const fair = await connect();
  const first = await until(
    () => fair.commands.find((command) => command.kind === "start"),
    (value) => value !== undefined
  );
  assert.ok(first);
  assert.equal(first.setId, peerSet.id);
  fair.send({ ...finished, requestId: first.requestId, setId: first.setId });
  const following = await until(
    () => fair.commands.filter((command) => command.kind === "start")[1],
    (value) => value !== undefined
  );
  assert.ok(following);
  assert.equal(following.setId, queued[0]?.id);
  for (const pending of queued) {
    await request(`/sets/${pending.id}/audio/download`, "DELETE");
  }
  fair.socket.close();
  transcript.push({
    nextPerson: following.setId,
    queuedLimit: 20,
    roundRobinFirst: first.setId,
  });
  await Bun.sleep(30);
  const fixture = path.join(artifact, "fixture.mp3");
  const generated = Bun.spawn([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    fixture,
  ]);
  assert.equal(await generated.exited, 0);
  const runner = path.join(artifact, "yt-dlp");
  await writeFile(
    runner,
    `#!/usr/bin/env python3\nimport sys, json, time\nif '--version' in sys.argv: print('fixture')\nelif '--dump-single-json' in sys.argv: print(json.dumps({'title':'Real fixture', 'duration':2}))\nelse:\n data=open(${JSON.stringify(fixture)},'rb').read()\n with open(sys.argv[sys.argv.index('-o')+1],'wb') as f:\n  f.write(data[:len(data)//2]); f.flush(); time.sleep(2); f.write(data[len(data)//2:])\n`,
    { mode: 0o755 }
  );
  const audioDir = path.join(artifact, "audio");
  const secret = path.join(artifact, "stream-grant.key");
  await writeFile(secret, Buffer.alloc(32, 17));
  const nodeBuild = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../server/src/node.ts")],
    outdir: path.resolve(import.meta.dir, "../../server/dist"),
    packages: "external",
    target: "bun",
  });
  assert.equal(nodeBuild.success, true, String(nodeBuild.logs));
  const api = await runtime.ready;
  const realSet = await save("real-node");
  const nodeLog: string[] = [];
  const launch = () => {
    const child = spawn(
      process.execPath,
      [path.resolve(import.meta.dir, "../../server/dist/node.js")],
      {
        detached: true,
        env: {
          ...process.env,
          ORBIS_API_FORWARD_URL: new URL("/api", api).toString(),
          ORBIS_AUDIO_DIR: audioDir,
          ORBIS_GROUP_URL: new URL("/api", api).toString(),
          ORBIS_NODE_KEY: "node-token",
          ORBIS_NODE_PORT: String(nodePort),
          ORBIS_STREAM_SECRET_FILE: secret,
          ORBIS_YTDLP_BIN: runner,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child.stdout.on("data", (data) => nodeLog.push(String(data)));
    child.stderr.on("data", (data) => nodeLog.push(String(data)));
    return child;
  };
  let child = launch();
  const stop = async () => {
    if (!child.pid || child.exitCode !== null) {
      return;
    }
    const exited = once(child, "exit");
    process.kill(-child.pid, "SIGKILL");
    await exited;
  };
  try {
    await until(
      () => state(realSet.id),
      (value) => value.state === "downloading" && value.bytesReceived > 0
    );
    const beforeJobs = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({ sequence: Schema.Number, set_id: Schema.String })
      )
    )(await (await request("/__node-jobs")).json());
    const beforeJob = beforeJobs.find((job) => job.set_id === realSet.id);
    assert.ok(beforeJob);
    await stop();
    child = launch();
    await until(
      () => state(realSet.id),
      (value) => value.state === "ready"
    );
    const afterJobs = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({ sequence: Schema.Number, set_id: Schema.String })
      )
    )(await (await request("/__node-jobs")).json());
    assert.deepEqual(
      afterJobs.filter((job) => job.set_id === realSet.id),
      [beforeJob]
    );
    assert.ok((await readdir(audioDir)).includes(`${realSet.id}.mp3`));
    const play = (setId: string) =>
      runtime.dispatchFetch(`http://orbis/api/sets/${setId}/audio`, {
        headers: { authorization: "Bearer client-token" },
        redirect: "manual",
      });
    const redirect = await play(realSet.id);
    assert.equal(redirect.status, 302);
    await redirect.arrayBuffer();
    const location = new URL(redirect.headers.get("location") ?? "");
    assert.equal(location.origin, `http://127.0.0.1:${nodePort}`);
    const ranged = await fetch(location, { headers: { range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const forged = new URL(location);
    forged.searchParams.set("grant", "forged");
    const refusedGrant = await fetch(forged);
    assert.equal(refusedGrant.status, 401);
    await refusedGrant.text();
    const absent = await play("absent");
    assert.equal(absent.status, 404);
    await absent.text();
    const missingFile = await fetch(
      `http://127.0.0.1:${nodePort}/api/sets/absent/audio?grant=${issueStreamGrant(Buffer.alloc(32, 17), "absent", "client")}`
    );
    assert.equal(missingFile.status, 404);
    await missingFile.text();
    await request(`/sets/${realSet.id}`, "DELETE");
    await until(
      () => readdir(audioDir),
      (files) => !files.includes(`${realSet.id}.mp3`)
    );
    assert.equal(
      (await readdir(audioDir)).some((file) => /sqlite|devices/u.test(file)),
      false
    );
    const groupRestartSet = await save("group-restart");
    await until(
      () => state(groupRestartSet.id),
      (value) => value.state === "downloading" && value.bytesReceived > 0
    );
    const jobsBeforeRestart = await (await request("/__node-jobs")).json();
    await runtime.dispose();
    runtime = new Miniflare({ ...runtimeOptions, port: Number(api.port) });
    await until(
      () => state(groupRestartSet.id),
      (value) => value.state === "ready"
    );
    assert.deepEqual(
      await (await request("/__node-jobs")).json(),
      jobsBeforeRestart
    );
    await request(`/sets/${groupRestartSet.id}`, "DELETE");
    await until(
      () => readdir(audioDir),
      (files) => !files.includes(`${groupRestartSet.id}.mp3`)
    );
    transcript.push(
      { groupRestart: true, resumedSameJob: true },
      {
        killedDuringProgress: true,
        realNode: true,
        releasedFile: true,
        resumedSameJob: beforeJob,
      }
    );
  } finally {
    await stop();
    await writeFile(path.join(artifact, "node.log"), nodeLog.join(""));
    await writeFile(path.join(artifact, "group.log"), groupLog.join("\n"));
  }
  const nodeAudio = audioEvents(nodeLog);
  assert.deepEqual(
    nodeAudio.map((event) => [
      event.ingress,
      event.status,
      event.audio.grant,
      event.audio.file,
    ]),
    [
      ["funnel-audio", 206, "valid", "found"],
      ["funnel-audio", 401, "malformed", undefined],
      ["funnel-audio", 404, "valid", "missing"],
    ]
  );
  assert.equal(nodeAudio[0]?.audio.bytes, 100);
  const groupAudio = audioEvents(groupLog);
  assert.deepEqual(
    groupAudio.map((event) => [
      event.status,
      event.audio.result,
      event.audio.reason,
      event.audio.node,
    ]),
    [
      [302, "redirected", undefined, `http://127.0.0.1:${nodePort}`],
      [404, "refused", "set-not-found", undefined],
    ]
  );
  assert.equal(
    [...nodeLog, ...groupLog].some((line) => line.includes("grant=")),
    false
  );
  transcript.push({ groupAudio, nodeAudio });
  const misconfigured = new Miniflare({
    ...runtimeOptions,
    bindings: { ...runtimeOptions.bindings, AUDIO_NODE_URL: "vanta:10000" },
    durableObjectsPersist: path.join(artifact, "misconfigured"),
  });
  try {
    const refused = await misconfigured.dispatchFetch(
      "http://orbis/api/health"
    );
    assert.equal(refused.status, 500);
    assert.match(
      await refused.text(),
      /AUDIO_NODE_URL must be an absolute http\(s\) URL\./u,
      "a bad AUDIO_NODE_URL fails Group construction, before any audio request"
    );
  } finally {
    await misconfigured.dispose();
  }
  await writeFile(path.join(artifact, "group.log"), groupLog.join("\n"));
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify({ passed: true, transcript }, null, 2)
  );
  console.log(`Audio node E2E passed. ${artifact}/result.json`);
} finally {
  await runtime.dispose();
}
