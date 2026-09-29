/* oxlint-disable no-await-in-loop -- Observe each heartbeat over the real idle interval. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createApp } from "../apps/server/src/app.ts";
import { hashToken } from "../apps/server/src/identity.ts";
import { startListeners } from "../apps/server/src/listeners.ts";

const duration = Number(process.env.ORBIS_EVENTS_IDLE_MS ?? 610_000);
const root = await mkdtemp(path.join(tmpdir(), "orbis-events-idle-"));
const token = crypto.randomUUID();
await writeFile(
  path.join(root, "devices.json"),
  JSON.stringify({
    keys: [
      {
        addedAt: new Date().toISOString(),
        id: "idle",
        label: "idle probe",
        lastUsedAt: null,
        personId: "host",
        scope: "daily",
        tokenHash: hashToken(token),
      },
    ],
    people: [{ id: "host", removed: false, username: "host" }],
    version: 2,
  })
);
const service = await startListeners(
  createApp({
    databasePath: path.join(root, "db.sqlite"),
    logging: { silent: true },
  }),
  { devicePort: 0, localPort: 0 }
);
const proxy = createServer((incoming, outgoing) => {
  const upstream = request(
    new URL(incoming.url ?? "/", service.device.url),
    {
      headers: incoming.headers,
      method: incoming.method,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.setTimeout(45_000, () =>
        response.destroy(new Error("Proxy idle timeout"))
      );
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    }
  );
  upstream.on("error", () => outgoing.destroy());
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const address = Schema.decodeUnknownSync(
  Schema.Struct({ port: Schema.Number })
)(proxy.address());
const controller = new AbortController();
let reader;
try {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (Date.now() - started < duration) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    chunks.push({
      elapsedMs: Date.now() - started,
      text: decoder.decode(chunk.value),
    });
  }
  const heartbeats = chunks.filter((chunk) =>
    chunk.text.includes('"heartbeat"')
  );
  assert.ok(heartbeats.length >= Math.floor(duration / 30_000));
  const evidence = {
    chunks,
    elapsedMs: Date.now() - started,
    heartbeatCount: heartbeats.length,
    productionFunnelVerified: false,
    proxy: "loopback HTTP reverse proxy, 45-second upstream idle timeout",
  };
  const directory = path.resolve(".cache/queue-events");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "idle-proxy.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(
    JSON.stringify({
      elapsedMs: evidence.elapsedMs,
      heartbeatCount: evidence.heartbeatCount,
    })
  );
} finally {
  controller.abort();
  await reader?.cancel().catch(() => null);
  proxy.closeAllConnections();
  const closed = once(proxy, "close");
  proxy.close();
  await closed;
  await service.stop();
  await rm(root, { force: true, recursive: true });
}
