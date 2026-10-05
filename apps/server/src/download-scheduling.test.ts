import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* oxlint-disable no-await-in-loop -- Sequential requests define the queue order and exercise its capacity boundary. */
import type { SaveSetInput } from "@orbis/contracts";
import { Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";

const statusOf = async (response: Promise<Response>) => {
  const result = await response;
  return result.status;
};

const Saved = Schema.Struct({ id: Schema.String });
const Source = Schema.Struct({ url: Schema.String });
const failureCases = [
  "one Person's backlog starves another Person",
  "the active job counts against the waiting limit",
  "duplicate requests consume another waiting slot",
  "the 21st waiting job changes state despite refusal",
  "restart loses requester turns or FIFO order",
  "cancellation fails to release a waiting slot",
];
const artifactDirectory = path.resolve(
  import.meta.dir,
  "../../../.cache/download-scheduling"
);

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("The worker did not reach the expected job");
    }
    await Bun.sleep(10);
  }
};

const fixture = async (startWorker: boolean) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-scheduling-"));
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["host", "a", "b"].map((id) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: id,
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        username: id,
      })),
      version: 2,
    })
  );
  const order: string[] = [];
  const held = Promise.withResolvers<Response>();
  let holdFirst = true;
  const cobalt = Bun.serve({
    async fetch(request) {
      const body: unknown = await request.json();
      order.push(Schema.decodeUnknownSync(Source)(body).url);
      if (holdFirst) {
        holdFirst = false;
        return held.promise;
      }
      return new Response("Controlled backend refusal", { status: 503 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  let workerEnabled = startWorker;
  const open = () =>
    startFixtureServer({
      app: createApp({
        audio: {
          audioDir: path.join(root, "audio"),
          cobaltApiKey: "test",
          cobaltUrl: cobalt.url.href,
          startWorker: workerEnabled,
        },
        databasePath: path.join(root, "library.sqlite"),
        logging: { silent: true },
      }),
      port: 0,
      token: "seeded-test-fixture",
    });
  let listeners = await open();
  const request = (
    person: string,
    route: string,
    method = "GET",
    body?: SaveSetInput
  ) => {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${person}`,
        "content-type": "application/json",
      },
      method,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetch(new URL(route, listeners.url), init);
  };
  const save = async (person: string, number: number) => {
    const url = `https://www.youtube.com/watch?v=fair${String(number).padStart(7, "0")}`;
    const response = await request(person, "/sets", "POST", {
      tags: [],
      title: `Job ${number}`,
      url,
    });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    return { id: Schema.decodeUnknownSync(Saved)(body).id, url };
  };
  return {
    order,
    release: () => {
      holdFirst = false;
      held.resolve(new Response(null, { status: 503 }));
    },
    request,
    restart: async (enabled = startWorker) => {
      workerEnabled = enabled;
      await listeners.stop();
      held.resolve(new Response(null, { status: 503 }));
      listeners = await open();
    },
    root,
    save,
    stop: async () => {
      held.resolve(new Response(null, { status: 503 }));
      await listeners.stop();
      await cobalt.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
};

test("downloads preserve Person turns and queued order across a restart", async () => {
  const lane = await fixture(true);
  try {
    const a0 = await lane.save("a", 0);
    const a2 = await lane.save("a", 2);
    const a1 = await lane.save("a", 1);
    const b0 = await lane.save("b", 3);
    const b1 = await lane.save("b", 4);
    expect(
      await statusOf(lane.request("a", `/sets/${a0.id}/audio/download`, "POST"))
    ).toBe(202);
    await waitUntil(() => lane.order.length === 1);
    for (const [person, set] of [
      ["a", a1],
      ["a", a2],
      ["b", b0],
      ["b", b1],
    ] as const) {
      expect(
        await statusOf(
          lane.request(person, `/sets/${set.id}/audio/download`, "POST")
        )
      ).toBe(202);
    }
    await lane.restart();
    await waitUntil(() => lane.order.length === 6);
    const expected = [a0.url, b0.url, a0.url, b1.url, a1.url, a2.url];
    expect(lane.order).toEqual(expected);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      path.join(artifactDirectory, "restart-order.json"),
      JSON.stringify({ expected, failureCases, observed: lane.order }, null, 2)
    );
  } finally {
    await lane.stop();
  }
}, 20_000);

test("only twenty waiting Downloads per Person, with duplicates and cancellation", async () => {
  const lane = await fixture(true);
  try {
    const active = await lane.save("a", 100);
    expect(
      await statusOf(
        lane.request("a", `/sets/${active.id}/audio/download`, "POST")
      )
    ).toBe(202);
    await waitUntil(() => lane.order.length === 1);
    const waiting: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const set = await lane.save("a", 101 + index);
      expect(
        await statusOf(
          lane.request("a", `/sets/${set.id}/audio/download`, "POST")
        )
      ).toBe(202);
      waiting.push(set.id);
    }
    expect(
      await statusOf(
        lane.request("a", `/sets/${active.id}/audio/download`, "POST")
      )
    ).toBe(200);
    const excess = await lane.save("a", 121);
    const refused = await lane.request(
      "a",
      `/sets/${excess.id}/audio/download`,
      "POST"
    );
    expect(refused.status).toBe(429);
    const refusal: unknown = await refused.json();
    expect(refusal).toEqual({
      message:
        "You can have at most 20 Downloads waiting. Try again after one starts.",
    });
    const state = await lane.request("a", `/sets/${excess.id}/audio/state`);
    expect(await state.json()).toMatchObject({ state: "none" });
    const b = await lane.save("b", 122);
    expect(
      await statusOf(lane.request("b", `/sets/${b.id}/audio/download`, "POST"))
    ).toBe(202);
    expect(
      await statusOf(
        lane.request("a", `/sets/${waiting[0]}/audio/download`, "DELETE")
      )
    ).toBe(200);
    expect(
      await statusOf(
        lane.request("a", `/sets/${excess.id}/audio/download`, "POST")
      )
    ).toBe(202);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      path.join(artifactDirectory, "capacity.json"),
      JSON.stringify(
        {
          acceptedAfterCancel: true,
          active: 1,
          failureCases,
          otherPersonAccepted: true,
          refusal,
          waiting: 20,
        },
        null,
        2
      )
    );
  } finally {
    await lane.stop();
  }
}, 20_000);

test("a legacy backlog of thirty jobs stays fair and keeps its order", async () => {
  const lane = await fixture(false);
  try {
    const old = [];
    for (let index = 0; index < 30; index += 1) {
      old.push(await lane.save("host", 200 + index));
    }
    const db = new Database(path.join(lane.root, "library.sqlite"));
    for (const [index, set] of old.entries()) {
      db.query(
        "UPDATE sets SET download_state = 'queued', created_at = ? WHERE id = ?"
      ).run(new Date(index * 1000).toISOString(), set.id);
    }
    db.run("DROP TABLE download_jobs");
    db.run("DROP TABLE download_requesters");
    db.run(
      "DELETE FROM __drizzle_migrations WHERE name = '20260929140000_fair_downloads'"
    );
    db.close();
    await lane.restart(false);
    const excess = await lane.save("host", 231);
    expect(
      await statusOf(
        lane.request("host", `/sets/${excess.id}/audio/download`, "POST")
      )
    ).toBe(429);
    const b = await lane.save("b", 230);
    expect(
      await statusOf(lane.request("b", `/sets/${b.id}/audio/download`, "POST"))
    ).toBe(202);
    lane.release();
    await lane.restart(true);
    await waitUntil(() => lane.order.length === 31);
    expect(lane.order.indexOf(b.url)).toBeLessThanOrEqual(1);
    expect(lane.order.filter((url) => url !== b.url)).toEqual(
      old.map((set) => set.url)
    );
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      path.join(artifactDirectory, "legacy-backlog.json"),
      JSON.stringify(
        {
          legacyRequester: "host",
          legacyWaiting: 30,
          observed: lane.order,
          otherPersonIndex: lane.order.indexOf(b.url),
        },
        null,
        2
      )
    );
  } finally {
    await lane.stop();
  }
}, 20_000);
