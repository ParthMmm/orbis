/* oxlint-disable no-await-in-loop -- SSE frames and ordered client actions are observed in sequence. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PresenceAction } from "@orbis/contracts";
import {
  PresenceActionResultSchema,
  PresenceConflictSchema,
  QueueEventSchema,
} from "@orbis/contracts/http-api";
import { Effect, Layer, Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { PresenceJournal } from "./presence-journal.js";
import type { PresenceTransition } from "./presence-journal.js";
import { createTestApp as createApp } from "./test-app.js";

const LEASE_MS = 1500;
const RETENTION_MS = 1500;
const LEGACY_WINDOW_MS = 1500;
const SETS = ["s1", "s2", "s3"];
const PEOPLE = ["host", "a", "b", "c"];
const KEYS = {
  "a-laptop": { personId: "a", scope: "daily" },
  "a-legacy": { personId: "a", scope: "daily" },
  "a-phone": { personId: "a", scope: "daily" },
  "b-phone": { personId: "b", scope: "daily" },
  "c-phone": { personId: "c", scope: "daily" },
  "host-node": { personId: "host", scope: "node" },
} as const;
type Key = keyof typeof KEYS;
const artifactDirectory =
  process.env.ORBIS_PRESENCE_ARTIFACTS ??
  path.resolve(import.meta.dir, "../../../.cache/presence-actions");

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueueEventSchema)
);
const decodeResult = Schema.decodeUnknownSync(PresenceActionResultSchema);
const decodeConflict = Schema.decodeUnknownSync(PresenceConflictSchema);

type Entries = readonly { personId: string; setId: string }[];
type Payload =
  | PresenceAction
  | { setId: string }
  | { seconds: number }
  | {
      actionId: string;
      actionNumber: number;
      kind: string;
      sessionId?: string;
      setId: string;
    };
type TranscriptEntry =
  | { transition: PresenceTransition }
  | { event: Entries; viewer: string }
  | {
      body: unknown;
      key: string;
      method: string;
      route: string;
      status: number;
    };
type Transcript = TranscriptEntry[];

const seed = async (root: string) => {
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: Object.entries(KEYS).map(([id, key]) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: key.personId,
        scope: key.scope,
        tokenHash: hashToken(id),
      })),
      people: PEOPLE.map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: id !== "host",
        username: id,
      })),
      version: 2,
    })
  );
  const migrator = createApp({ databasePath, logging: { silent: true } });
  try {
    const health = await migrator.initialize();
    expect(health.status).toBe(200);
  } finally {
    await migrator.dispose();
  }
  const sqlite = new Database(databasePath);
  try {
    for (const [index, id] of SETS.entries()) {
      sqlite.run(
        `INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
         VALUES (?, ?, ?, 'youtube', '[]', '2026-04-01T00:00:00.000Z', 1, 'ready', ?)`,
        [
          id,
          `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`,
          id,
          600 + index,
        ]
      );
      for (const personId of ["a", "b"]) {
        sqlite.run(
          "INSERT INTO library_entries (person_id, set_id, saved_at, tags) VALUES (?, ?, '2026-04-01T00:00:00.000Z', '[]')",
          [personId, id]
        );
      }
    }
  } finally {
    sqlite.close();
  }
  return databasePath;
};

const harness = (databasePath: string, transcript: Transcript) => {
  const transitions: PresenceTransition[] = [];
  const journal = Layer.succeed(PresenceJournal, {
    record: (_tx, transition) =>
      Effect.sync(() => {
        transitions.push(transition);
        transcript.push({ transition });
      }),
  });
  const start = async () => {
    const listeners = await startFixtureServer({
      app: createApp({
        databasePath,
        logging: { silent: true },
        presence: {
          journal,
          leaseMs: LEASE_MS,
          resultRetentionMs: RETENTION_MS,
        },
        presenceWindowMs: LEGACY_WINDOW_MS,
      }),
      port: 0,
      token: "seeded-test-fixture",
    });
    const call = async (
      key: Key | "admin",
      route: string,
      method = "GET",
      payload?: Payload
    ) => {
      const headers =
        key === "admin"
          ? {
              "content-type": "application/json",
              "x-orbis-test-auth": "fixture",
            }
          : {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            };
      const init: RequestInit = { headers, method };
      if (payload !== undefined) {
        init.body = JSON.stringify(payload);
      }
      const response = await fetch(new URL(route, listeners.url), init);
      const body: unknown = await response.json();
      transcript.push({ body, key, method, route, status: response.status });
      return { body, status: response.status };
    };
    const callStatus = async (...args: Parameters<typeof call>) => {
      const response = await call(...args);
      return response.status;
    };
    const act = (key: Key | "admin", action: Payload) =>
      call(key, "/presence/actions", "POST", action);
    const actStatus = async (key: Key | "admin", action: Payload) => {
      const response = await act(key, action);
      return response.status;
    };
    const accepted = async (key: Key, action: PresenceAction) => {
      const response = await act(key, action);
      expect(response.status).toBe(200);
      return decodeResult(response.body);
    };
    const refused = async (
      key: Key,
      action: PresenceAction,
      reason: (typeof PresenceConflictSchema.Type)["reason"]
    ) => {
      const response = await act(key, action);
      expect(response.status).toBe(409);
      expect(decodeConflict(response.body).reason).toBe(reason);
    };
    const watch = async (key: Key, viewer: string) => {
      const response = await fetch(new URL("/events", listeners.url), {
        headers: { authorization: `Bearer ${key}` },
      });
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("The event response has no stream");
      }
      const decoder = new TextDecoder();
      let pending = "";
      const read = async () => {
        while (!pending.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error("The event stream closed");
          }
          pending += decoder.decode(chunk.value, { stream: true });
        }
        const boundary = pending.indexOf("\n\n");
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = decodeEvent(
          frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
        );
        if (event.kind === "presence") {
          transcript.push({
            event: event.presence.map((entry) => ({
              personId: entry.personId,
              setId: entry.set.id,
            })),
            viewer,
          });
        }
        return event;
      };
      return {
        close: () => reader.cancel(),
        presence: async (accept: (entries: Entries) => boolean, ms = 6000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            const event = await Promise.race([
              read(),
              Bun.sleep(deadline - Date.now()).then(() => null),
            ]);
            if (event?.kind === "presence") {
              const entries = event.presence.map((entry) => ({
                personId: entry.personId,
                setId: entry.set.id,
              }));
              if (accept(entries)) {
                return entries;
              }
            }
          }
          throw new Error("No matching presence event arrived");
        },
      };
    };
    return {
      accepted,
      act,
      actStatus,
      call,
      callStatus,
      listeners,
      refused,
      watch,
    };
  };
  return { start, transitions };
};

const listening = (personId: string, setId: string) => (entries: Entries) =>
  entries.some((entry) => entry.personId === personId && entry.setId === setId);
const absent = (personId: string) => (entries: Entries) =>
  entries.every((entry) => entry.personId !== personId);

const saveTranscript = async (name: string, transcript: Transcript) => {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, name),
    `${JSON.stringify(transcript, null, 2)}\n`
  );
};

const listenCount = async (
  call: Awaited<ReturnType<ReturnType<typeof harness>["start"]>>["call"],
  key: Key,
  setId: string
) => {
  const queue = await call(key, "/queue");
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      queue: Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            finishCount: Schema.Number,
            id: Schema.String,
            listenCount: Schema.Number,
          })
        ),
      }),
    })
  )(queue.body);
  return decoded.queue.entries.find((entry) => entry.id === setId);
};

test("explicit actions own live Presence through play, pause, resume, stale devices, and retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-presence-actions-"));
  const transcript: Transcript = [];
  const databasePath = await seed(root);
  const { start, transitions } = harness(databasePath, transcript);
  let server = await start();
  const opened: { close: () => Promise<void> }[] = [];
  try {
    let viewer = await server.watch("c-phone", "c");
    opened.push(viewer);
    await viewer.presence((entries) => entries.length === 0);

    const play1: PresenceAction = {
      actionId: "p1",
      actionNumber: 1,
      kind: "play",
      sessionId: "phone-s1",
      setId: "s1",
    };
    expect(await server.actStatus("admin", play1)).toBe(403);
    expect(await server.actStatus("host-node", play1)).toBe(403);
    expect(
      await server.actStatus("a-phone", { ...play1, sessionId: undefined })
    ).toBe(400);
    expect(await server.actStatus("a-phone", { ...play1, kind: "seek" })).toBe(
      400
    );
    expect(
      await server.actStatus("a-phone", { ...play1, actionNumber: -1 })
    ).toBe(400);

    expect(
      await server.callStatus("a-phone", "/queue/active", "PUT", {
        setId: "s1",
      })
    ).toBe(200);
    await server.refused("a-phone", { ...play1, setId: "s2" }, "queue-changed");
    expect(transitions).toHaveLength(0);

    const first = await server.accepted("a-phone", play1);
    expect(first.outcome).toBe("accepted");
    expect(first.session.state).toBe("playing");
    const generation1 = first.session.ownerGeneration;
    if (first.session.state !== "playing") {
      throw new Error("expected a playing session");
    }
    const firstDeadline = Date.parse(first.session.leaseExpiresAt);
    expect(firstDeadline - Date.now()).toBeGreaterThan(LEASE_MS / 2);
    expect(firstDeadline - Date.now()).toBeLessThanOrEqual(LEASE_MS);
    await viewer.presence(listening("a", "s1"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "play",
      personId: "a",
      visibleSetAfter: "s1",
      visibleSetBefore: null,
    });

    let actionNumber = 1;
    let lastDeadline = firstDeadline;
    const transitionsBeforeRenewals = transitions.length;
    while (Date.now() < firstDeadline + LEASE_MS / 2) {
      actionNumber += 1;
      const renewed = await server.accepted("a-phone", {
        actionId: `r${actionNumber}`,
        actionNumber,
        kind: "renew",
        ownerGeneration: generation1,
        sessionId: "phone-s1",
      });
      if (renewed.session.state !== "playing") {
        throw new Error("a renewed session stays playing");
      }
      expect(Date.parse(renewed.session.leaseExpiresAt)).toBeGreaterThanOrEqual(
        lastDeadline
      );
      lastDeadline = Date.parse(renewed.session.leaseExpiresAt);
      await Bun.sleep(LEASE_MS / 4);
    }
    expect(transitions).toHaveLength(transitionsBeforeRenewals);

    expect(
      await server.callStatus("a-phone", "/sets/s1/position", "PUT", {
        seconds: 42,
      })
    ).toBe(200);
    expect(await listenCount(server.call, "a-phone", "s1")).toMatchObject({
      listenCount: 1,
    });
    expect(transitions).toHaveLength(transitionsBeforeRenewals);

    actionNumber += 1;
    const pause: PresenceAction = {
      actionId: "pause-1",
      actionNumber,
      kind: "pause",
      ownerGeneration: generation1,
      sessionId: "phone-s1",
    };
    const paused = await server.accepted("a-phone", pause);
    expect(paused).toMatchObject({
      outcome: "accepted",
      session: { state: "paused" },
    });
    await viewer.presence(absent("a"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "pause",
      visibleSetAfter: null,
      visibleSetBefore: "s1",
    });
    expect(await server.accepted("a-phone", pause)).toEqual({
      ...paused,
      outcome: "duplicate",
    });

    expect(
      await server.callStatus("a-legacy", "/sets/s1/position", "PUT", {
        seconds: 7,
      })
    ).toBe(200);
    await viewer.presence(listening("a", "s1"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "legacy-report",
      visibleSetAfter: "s1",
      visibleSetBefore: null,
    });
    await viewer.presence(absent("a"), LEGACY_WINDOW_MS + 6000);
    expect(transitions.at(-1)).toMatchObject({
      cause: "legacy-expiry",
      visibleSetAfter: null,
      visibleSetBefore: "s1",
    });

    actionNumber += 1;
    const resumed = await server.accepted("a-phone", {
      actionId: "p2",
      actionNumber,
      kind: "play",
      sessionId: "phone-s1",
      setId: "s1",
    });
    expect(resumed.session.state).toBe("playing");
    expect(resumed.session.ownerGeneration).toBeGreaterThan(generation1);
    const generation2 = resumed.session.ownerGeneration;
    await viewer.presence(listening("a", "s1"));
    expect(await listenCount(server.call, "a-phone", "s1")).toMatchObject({
      listenCount: 1,
    });

    const transitionsBeforeLegacy = transitions.length;
    expect(
      await server.callStatus("a-legacy", "/sets/s1/position", "PUT", {
        seconds: 9,
      })
    ).toBe(200);
    expect(transitions).toHaveLength(transitionsBeforeLegacy);

    const laptop = await server.accepted("a-laptop", {
      actionId: "l1",
      actionNumber: 1,
      kind: "play",
      sessionId: "laptop-s1",
      setId: "s1",
    });
    expect(laptop.session.ownerGeneration).toBeGreaterThan(generation2);
    const generation3 = laptop.session.ownerGeneration;
    actionNumber += 1;
    await server.refused(
      "a-phone",
      {
        actionId: "stale-pause",
        actionNumber,
        kind: "pause",
        ownerGeneration: generation2,
        sessionId: "phone-s1",
      },
      "stale"
    );
    await server.refused(
      "a-phone",
      {
        actionId: "stale-renew",
        actionNumber: actionNumber + 1,
        kind: "renew",
        ownerGeneration: generation2,
        sessionId: "phone-s1",
      },
      "stale"
    );
    expect(
      await server.accepted("a-laptop", {
        actionId: "l2",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration: generation3,
        sessionId: "laptop-s1",
      })
    ).toMatchObject({ session: { state: "playing" } });

    await server.accepted("a-laptop", {
      actionId: "l5",
      actionNumber: 5,
      kind: "renew",
      ownerGeneration: generation3,
      sessionId: "laptop-s1",
    });
    await server.refused(
      "a-laptop",
      {
        actionId: "l3",
        actionNumber: 3,
        kind: "pause",
        ownerGeneration: generation3,
        sessionId: "laptop-s1",
      },
      "stale"
    );
    await server.refused(
      "a-laptop",
      {
        actionId: "l5",
        actionNumber: 5,
        kind: "pause",
        ownerGeneration: generation3,
        sessionId: "laptop-s1",
      },
      "action-reused"
    );
    await server.refused(
      "a-laptop",
      {
        actionId: "l6",
        actionNumber: 6,
        kind: "play",
        sessionId: "laptop-s1",
        setId: "s2",
      },
      "session-set"
    );

    const replay: PresenceAction = {
      actionId: "l7",
      actionNumber: 7,
      kind: "play",
      sessionId: "laptop-s1",
      setId: "s1",
    };
    const replayed = await server.accepted("a-laptop", replay);
    expect(replayed.outcome).toBe("accepted");
    expect(await server.accepted("a-laptop", replay)).toEqual({
      ...replayed,
      outcome: "duplicate",
    });
    await viewer.close();
    await server.listeners.stop();
    server = await start();
    viewer = await server.watch("c-phone", "c");
    opened.push(viewer);
    expect(await server.accepted("a-laptop", replay)).toEqual({
      ...replayed,
      outcome: "duplicate",
    });

    await Bun.sleep(RETENTION_MS + 200);
    await server.refused("a-laptop", replay, "stale");
    const renewAfterPrune = await server.accepted("a-laptop", {
      actionId: "l7",
      actionNumber: 8,
      kind: "play",
      sessionId: "laptop-s1",
      setId: "s1",
    });
    expect(renewAfterPrune.outcome).toBe("accepted");
    expect(renewAfterPrune.session.state).toBe("playing");
    const generation4 = renewAfterPrune.session.ownerGeneration;
    await viewer.presence(listening("a", "s1"));

    expect(
      await server.accepted("a-laptop", {
        actionId: "l9",
        actionNumber: 9,
        kind: "stop",
        ownerGeneration: generation4,
        sessionId: "laptop-s1",
      })
    ).toMatchObject({ session: { state: "stopped" } });
    await viewer.presence(absent("a"));
    await server.refused(
      "a-laptop",
      {
        actionId: "l10",
        actionNumber: 10,
        kind: "renew",
        ownerGeneration: generation4,
        sessionId: "laptop-s1",
      },
      "stale"
    );
    await server.refused(
      "a-laptop",
      {
        actionId: "l11",
        actionNumber: 11,
        kind: "play",
        sessionId: "laptop-s1",
        setId: "s1",
      },
      "stale"
    );
    expect(await listenCount(server.call, "a-laptop", "s1")).toMatchObject({
      listenCount: 1,
    });
  } finally {
    await Promise.all(opened.map((open) => open.close().catch(() => null)));
    await server.listeners.stop();
    await saveTranscript("lifecycle.json", transcript);
    await rm(root, { force: true, recursive: true });
  }
}, 90_000);

test("Queue changes, lease expiry, revocation, the session cap, and removal clear ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-presence-queue-"));
  const transcript: Transcript = [];
  const databasePath = await seed(root);
  const { start, transitions } = harness(databasePath, transcript);
  const server = await start();
  const opened: { close: () => Promise<void> }[] = [];
  try {
    const viewer = await server.watch("c-phone", "c");
    opened.push(viewer);
    await viewer.presence((entries) => entries.length === 0);
    expect(
      await server.callStatus("a-phone", "/queue/active", "PUT", {
        setId: "s1",
      })
    ).toBe(200);
    const owner = await server.accepted("a-phone", {
      actionId: "q1",
      actionNumber: 1,
      kind: "play",
      sessionId: "race-s1",
      setId: "s1",
    });
    await viewer.presence(listening("a", "s1"));

    const [queueChange, raced] = await Promise.all([
      server.call("a-phone", "/queue/active", "PUT", { setId: "s2" }),
      server.act("a-phone", {
        actionId: "q2",
        actionNumber: 1,
        kind: "play",
        sessionId: "race-s1-late",
        setId: "s1",
      }),
    ]);
    expect(queueChange.status).toBe(200);
    expect([200, 409]).toContain(raced.status);
    if (raced.status === 409) {
      expect(decodeConflict(raced.body).reason).toBe("queue-changed");
    }
    await server.refused(
      "a-phone",
      {
        actionId: "q3",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration: owner.session.ownerGeneration,
        sessionId: "race-s1",
      },
      "stale"
    );
    await server.refused(
      "a-phone",
      {
        actionId: "q4",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration:
          raced.status === 200
            ? decodeResult(raced.body).session.ownerGeneration
            : owner.session.ownerGeneration,
        sessionId: "race-s1-late",
      },
      "stale"
    );
    await viewer.presence(absent("a"));

    const second = await server.accepted("a-phone", {
      actionId: "q5",
      actionNumber: 1,
      kind: "play",
      sessionId: "phone-s2",
      setId: "s2",
    });
    await viewer.presence(listening("a", "s2"));
    const completion = await server.call(
      "a-phone",
      "/queue/completion",
      "POST",
      {
        setId: "s2",
      }
    );
    expect(completion.status).toBe(200);
    expect(await listenCount(server.call, "a-phone", "s1")).toMatchObject({
      listenCount: 2,
    });
    await viewer.presence(absent("a"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "queue",
      visibleSetAfter: null,
      visibleSetBefore: "s2",
    });
    await server.refused(
      "a-phone",
      {
        actionId: "q6",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration: second.session.ownerGeneration,
        sessionId: "phone-s2",
      },
      "stale"
    );
    const advanced = await server.accepted("a-phone", {
      actionId: "q7",
      actionNumber: 1,
      kind: "play",
      sessionId: "phone-s1-again",
      setId: "s1",
    });
    await viewer.presence(listening("a", "s1"));

    const expiredAt = Date.now();
    await viewer.presence(absent("a"), LEASE_MS + 6000);
    expect(Date.now() - expiredAt).toBeGreaterThanOrEqual(LEASE_MS - 100);
    expect(transitions.at(-1)).toMatchObject({
      cause: "expiry",
      personId: "a",
      visibleSetAfter: null,
      visibleSetBefore: "s1",
    });
    await server.refused(
      "a-phone",
      {
        actionId: "q8",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration: advanced.session.ownerGeneration,
        sessionId: "phone-s1-again",
      },
      "stale"
    );
    const reacquired = await server.accepted("a-phone", {
      actionId: "q9",
      actionNumber: 3,
      kind: "play",
      sessionId: "phone-s1-again",
      setId: "s1",
    });
    expect(reacquired.session.ownerGeneration).toBeGreaterThan(
      advanced.session.ownerGeneration
    );
    await viewer.presence(listening("a", "s1"));

    const revoked = await server.call("admin", "/admin/keys/a-phone", "DELETE");
    expect(revoked.status).toBe(200);
    await viewer.presence(absent("a"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "revocation",
      visibleSetAfter: null,
      visibleSetBefore: "s1",
    });
    expect(
      await server.actStatus("a-phone", {
        actionId: "q10",
        actionNumber: 4,
        kind: "renew",
        ownerGeneration: reacquired.session.ownerGeneration,
        sessionId: "phone-s1-again",
      })
    ).toBe(401);

    const sqlite = new Database(databasePath);
    try {
      const insert = sqlite.prepare(
        `INSERT INTO presence_sessions (key_id, session_id, person_id, set_id, state, owner_generation, action_number, lease_expires_at, updated_at)
         VALUES ('b-phone', ?, 'b', 's1', 'superseded', 0, 0, NULL, 0)`
      );
      sqlite.transaction(() => {
        for (let index = 0; index < 10_000; index += 1) {
          insert.run(`old-${index}`);
        }
      })();
    } finally {
      sqlite.close();
    }
    expect(
      await server.callStatus("b-phone", "/queue/active", "PUT", {
        setId: "s1",
      })
    ).toBe(200);
    await server.refused(
      "b-phone",
      {
        actionId: "b1",
        actionNumber: 1,
        kind: "play",
        sessionId: "b-new",
        setId: "s1",
      },
      "session-limit"
    );
    await server.accepted("b-phone", {
      actionId: "b2",
      actionNumber: 1,
      kind: "play",
      sessionId: "old-42",
      setId: "s1",
    });
    await viewer.presence(listening("b", "s1"));

    const removal = await server.call("admin", "/admin/people/b", "DELETE");
    expect(removal.status).toBe(200);
    await viewer.presence(absent("b"));
    expect(transitions.at(-1)).toMatchObject({
      cause: "removal",
      personId: "b",
      visibleSetAfter: null,
      visibleSetBefore: "s1",
    });
    const remaining = new Database(databasePath, { readonly: true });
    try {
      expect(
        remaining
          .query(
            "SELECT count(*) AS sessions FROM presence_sessions WHERE person_id = 'b'"
          )
          .get()
      ).toEqual({ sessions: 0 });
      expect(
        remaining
          .query(
            "SELECT count(*) AS sessions FROM presence_sessions WHERE key_id = 'a-phone'"
          )
          .get()
      ).toEqual({ sessions: 0 });
    } finally {
      remaining.close();
    }
  } finally {
    await Promise.all(opened.map((open) => open.close().catch(() => null)));
    await server.listeners.stop();
    await saveTranscript("queue-expiry-revocation.json", transcript);
    await rm(root, { force: true, recursive: true });
  }
}, 90_000);
