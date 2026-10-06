/* oxlint-disable no-await-in-loop -- Feed clients catch up in the order the journeys write. */
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ListeningQueue } from "@orbis/contracts";

import type { CatchUp, FeedNotice } from "./feed.js";
import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";

setDefaultTimeout(30_000);

const PEOPLE = ["host", "ana", "ben", "cai"] as const;
const KEYS = {
  "ana-laptop": "ana",
  "ana-phone": "ana",
  "ben-phone": "ben",
  "ben-tablet": "ben",
  "cai-phone": "cai",
} as const;
type Key = keyof typeof KEYS;
const SHARED_SETS = ["set-1", "set-2", "set-3"];
const CAI_SET = "cai-only";
const tokenFor = (key: Key) => `token-${key}`;
const artifactDirectory =
  process.env.ORBIS_FEED_ARTIFACTS ??
  path.resolve(import.meta.dir, "../../../.cache/feed");

type TraceEntry =
  | {
      at: number;
      key: Key | "admin";
      method: string;
      route: string;
      status: number;
    }
  | { at: number; key: Key; sent: string | null; result: CatchUp }
  | { at: number; notice: FeedNotice }
  | { at: number; step: string };

const seed = async (root: string) => {
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: Object.entries(KEYS).map(([id, personId]) => ({
        addedAt: "2026-10-01T00:00:00.000Z",
        id,
        label: id,
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(tokenFor(id as Key)),
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
    expect((await migrator.initialize()).status).toBe(200);
  } finally {
    await migrator.dispose();
  }
  const sqlite = new Database(databasePath);
  try {
    const insertSet = (id: string, index: number) =>
      sqlite.run(
        `INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
         VALUES (?, ?, ?, 'youtube', '[]', '2026-10-01T00:00:00.000Z', 1, 'ready', ?)`,
        [
          id,
          `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`,
          id,
          600 + index,
        ]
      );
    const own = (personId: string, setId: string) =>
      sqlite.run(
        "INSERT INTO library_entries (person_id, set_id, saved_at, tags) VALUES (?, ?, '2026-10-01T00:00:00.000Z', '[]')",
        [personId, setId]
      );
    for (const [index, id] of SHARED_SETS.entries()) {
      insertSet(id, index);
      for (const personId of ["ana", "ben"]) {
        own(personId, id);
      }
    }
    insertSet(CAI_SET, 9);
    own("cai", CAI_SET);
  } finally {
    sqlite.close();
  }
  return databasePath;
};

interface Options {
  readonly feed?: { retentionMs?: number; retentionCount?: number };
  readonly leaseMs?: number;
}

const start = (databasePath: string, trace: TraceEntry[], options = {}) => {
  const { feed, leaseMs }: Options = options;
  const app = createApp({
    databasePath,
    ...(feed && { feed }),
    logging: { silent: true },
    presence: { leaseMs: leaseMs ?? 30_000 },
    presenceWindowMs: 1500,
  });
  const listeners = startFixtureServer({ app, port: 0, token: "feed-fixture" });
  const notices: FeedNotice[] = [];
  const unsubscribe = app.feed.subscribe((notice) => {
    notices.push(notice);
    trace.push({ at: Date.now(), notice });
  });
  const call = async (
    key: Key | "admin",
    route: string,
    method = "GET",
    payload?: unknown
  ) => {
    const headers: Record<string, string> =
      key === "admin"
        ? { "x-orbis-test-auth": "fixture" }
        : { authorization: `Bearer ${tokenFor(key)}` };
    headers["content-type"] = "application/json";
    const init: RequestInit = { headers, method };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    const response = await fetch(new URL(route, listeners.url), init);
    const body: unknown = await response.json();
    trace.push({ at: Date.now(), key, method, route, status: response.status });
    return { body, status: response.status };
  };
  const ok = async (
    key: Key | "admin",
    route: string,
    method = "GET",
    payload?: unknown
  ) => {
    const response = await call(key, route, method, payload);
    expect(response.status).toBeLessThan(300);
    return response.body;
  };
  const catchUp = async (key: Key, cursor: string | null) => {
    const result = await app.feed.catchUp({ cursor, keyId: key });
    trace.push({ at: Date.now(), key, result, sent: cursor });
    return result;
  };
  const client = (key: Key) => {
    let cursor: string | null = null;
    return {
      get cursor() {
        return cursor;
      },
      key,
      set cursor(value: string | null) {
        cursor = value;
      },
      sync: async () => {
        const result = await catchUp(key, cursor);
        if (result.kind === "snapshot") {
          ({ cursor } = result.snapshot);
        } else if (result.kind === "changes") {
          ({ cursor } = result);
        }
        return result;
      },
    };
  };
  const step = (name: string) => trace.push({ at: Date.now(), step: name });
  const stop = async () => {
    unsubscribe();
    await listeners.stop();
  };
  return { app, call, catchUp, client, notices, ok, step, stop };
};

const saveTrace = async (name: string, trace: TraceEntry[]) => {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, name),
    `${JSON.stringify(trace, null, 2)}\n`
  );
};

const changes = (result: CatchUp) => {
  if (result.kind !== "changes") {
    throw new Error(`Expected changes, got ${result.kind}`);
  }
  return result.deliveries;
};
const reset = (result: CatchUp) => {
  if (result.kind !== "snapshot") {
    throw new Error(`Expected a snapshot, got ${result.kind}`);
  }
  return result;
};
const invalidations = (result: CatchUp) =>
  changes(result).flatMap((delivery) =>
    delivery.body.kind === "invalidate"
      ? [{ resourceId: delivery.body.resourceId, topic: delivery.body.topic }]
      : []
  );
const presenceOf = (result: CatchUp) => {
  const bodies =
    result.kind === "snapshot"
      ? [result.snapshot.presence]
      : changes(result).flatMap((delivery) =>
          delivery.body.kind === "presence" ? [delivery.body.presence] : []
        );
  return bodies.map((entries) =>
    entries.map((entry) => ({ personId: entry.personId, setId: entry.set.id }))
  );
};
const quiet = (result: CatchUp, cursor: string | null) => {
  expect(changes(result)).toEqual([]);
  expect(result.kind === "changes" && result.cursor).toBe(cursor ?? "");
};
const sorted = (ids: readonly string[]) =>
  [...ids].sort((left, right) => left.localeCompare(right));
const play = (setId: string, actionNumber: number) => ({
  actionId: `play-${actionNumber}`,
  actionNumber,
  kind: "play",
  sessionId: `session-${setId}`,
  setId,
});

const withRoot = async (
  name: string,
  journey: (
    root: string,
    databasePath: string,
    trace: TraceEntry[]
  ) => Promise<void>
) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-feed-"));
  const trace: TraceEntry[] = [];
  try {
    await journey(root, await seed(root), trace);
  } finally {
    await saveTrace(name, trace);
    await rm(root, { force: true, recursive: true });
  }
};

test("a Person's other devices receive Library, Queue, and Playlist changes once each, and replay repeats them", async () => {
  await withRoot("own-devices.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    try {
      const phone = fixture.client("ana-phone");
      const laptop = fixture.client("ana-laptop");
      const ben = fixture.client("ben-phone");
      for (const device of [phone, laptop, ben]) {
        const first = reset(await device.sync());
        expect(first.reset).toBeNull();
        expect(first.snapshot.queue).toEqual({
          activeSetId: null,
          entries: [],
        });
      }

      fixture.step("tag a Set on the phone");
      await fixture.ok("ana-phone", "/sets/set-1/tags", "PATCH", {
        tags: ["warm"],
      });
      expect(invalidations(await laptop.sync())).toEqual([
        { resourceId: "set-1", topic: "library" },
      ]);
      const benBefore = ben.cursor;
      quiet(await ben.sync(), benBefore);

      fixture.step("save three positions; replay collapses them");
      const beforePositions = laptop.cursor;
      for (const seconds of [10, 20, 30]) {
        await fixture.ok("ana-phone", "/sets/set-1/position", "PUT", {
          seconds,
        });
      }
      const collapsed = await laptop.sync();
      expect(invalidations(collapsed)).toEqual([
        { resourceId: "set-1", topic: "library" },
      ]);
      const replayed = await fixture.catchUp("ana-laptop", beforePositions);
      const again = await fixture.catchUp("ana-laptop", beforePositions);
      expect(again).toEqual(replayed);
      expect(replayed).toEqual(collapsed);

      fixture.step("make a Set active");
      await fixture.ok("ana-phone", "/queue/active", "PUT", { setId: "set-2" });
      const queued = changes(await laptop.sync());
      expect(queued.map((delivery) => delivery.body.kind)).toContain("queue");
      const queue = queued.find((delivery) => delivery.body.kind === "queue");
      expect(queue?.body.kind === "queue" && queue.body.queue.activeSetId).toBe(
        "set-2"
      );
      expect(invalidations(await ben.sync())).toEqual([
        { resourceId: "ana", topic: "listen-history" },
      ]);

      fixture.step("title, removal, and Playlist edits");
      await fixture.ok("ana-phone", "/sets/set-1/title", "PATCH", {
        title: "Morning",
      });
      await fixture.ok("ana-phone", "/sets/set-3", "DELETE");
      const created = (await fixture.ok("ana-phone", "/playlists", "POST", {
        name: "Mix",
      })) as { id: string };
      await fixture.ok("ana-phone", `/playlists/${created.id}/sets`, "PUT", {
        setIds: ["set-1"],
      });
      const edits = invalidations(await laptop.sync());
      expect(edits).toContainEqual({ resourceId: "set-1", topic: "library" });
      expect(edits).toContainEqual({ resourceId: "set-3", topic: "library" });
      expect(edits).toContainEqual({
        resourceId: created.id,
        topic: "playlist",
      });
      const benQuiet = ben.cursor;
      quiet(await ben.sync(), benQuiet);

      const cursors = changes(
        await fixture.catchUp("ana-laptop", beforePositions)
      ).map((delivery) => delivery.cursor);
      expect(new Set(cursors).size).toBe(cursors.length);
    } finally {
      await fixture.stop();
    }
  });
});

test("Presence actions, legacy reports, and expiry reach viewers, and renewals consume no sequence", async () => {
  await withRoot("presence.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace, { leaseMs: 1500 });
    try {
      const ben = fixture.client("ben-phone");
      const cai = fixture.client("cai-phone");
      reset(await ben.sync());
      reset(await cai.sync());
      await fixture.ok("ana-phone", "/queue/active", "PUT", { setId: "set-1" });
      await ben.sync();
      await cai.sync();

      fixture.step("explicit play");
      const played = (await fixture.ok(
        "ana-phone",
        "/presence/actions",
        "POST",
        play("set-1", 1)
      )) as { session: { ownerGeneration: number } };
      expect(presenceOf(await ben.sync())).toEqual([
        [{ personId: "ana", setId: "set-1" }],
      ]);
      expect(presenceOf(await cai.sync())).toEqual([
        [{ personId: "ana", setId: "set-1" }],
      ]);

      fixture.step("renewal changes nothing visible");
      const beforeRenew = ben.cursor;
      await fixture.ok("ana-phone", "/presence/actions", "POST", {
        actionId: "renew-2",
        actionNumber: 2,
        kind: "renew",
        ownerGeneration: played.session.ownerGeneration,
        sessionId: "session-set-1",
      });
      quiet(await ben.sync(), beforeRenew);

      fixture.step("pause clears it");
      await fixture.ok("ana-phone", "/presence/actions", "POST", {
        actionId: "pause-3",
        actionNumber: 3,
        kind: "pause",
        ownerGeneration: played.session.ownerGeneration,
        sessionId: "session-set-1",
      });
      expect(presenceOf(await ben.sync())).toEqual([[]]);

      fixture.step(
        "a legacy report from the laptop supplies Presence, then expires"
      );
      await fixture.ok("ana-laptop", "/sets/set-1/position", "PUT", {
        seconds: 5,
      });
      expect(presenceOf(await ben.sync())).toEqual([
        [{ personId: "ana", setId: "set-1" }],
      ]);
      await Bun.sleep(2500);
      expect(presenceOf(await ben.sync())).toEqual([[]]);

      fixture.step("explicit lease expiry");
      await fixture.ok(
        "ana-phone",
        "/presence/actions",
        "POST",
        play("set-1", 4)
      );
      expect(presenceOf(await ben.sync())).toEqual([
        [{ personId: "ana", setId: "set-1" }],
      ]);
      await Bun.sleep(2500);
      expect(presenceOf(await ben.sync())).toEqual([[]]);
      expect(
        fixture.notices.filter(
          (notice) => notice.kind === "changed" && notice.personId === "ben"
        ).length
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await fixture.stop();
    }
  });
});

const DIRECTIONS = [
  {
    hide: ["ana-phone", "/people/ben/filters", "PUT", { see: false }],
    name: "ana stops seeing ben",
    show: ["ana-phone", "/people/ben/filters", "PUT", { see: true }],
    symmetric: false,
  },
  {
    hide: ["ben-phone", "/people/ana/filters", "PUT", { appear: false }],
    name: "ben stops appearing to ana",
    show: ["ben-phone", "/people/ana/filters", "PUT", { appear: true }],
    symmetric: false,
  },
  {
    hide: ["ana-phone", "/me", "PATCH", { social: false }],
    name: "ana turns Social off",
    show: ["ana-phone", "/me", "PATCH", { social: true }],
    symmetric: true,
  },
  {
    hide: ["ben-phone", "/me", "PATCH", { social: false }],
    name: "ben turns Social off",
    show: ["ben-phone", "/me", "PATCH", { social: true }],
    symmetric: true,
  },
] as const;

for (const direction of DIRECTIONS) {
  test(`${direction.name}: replay hides activity, resets without hidden IDs, and matches HTTP`, async () => {
    const file = `filter-${direction.name.replaceAll(" ", "-")}.json`;
    await withRoot(file, async (_root, databasePath, trace) => {
      const fixture = start(databasePath, trace);
      try {
        const ana = fixture.client("ana-phone");
        const ben = fixture.client("ben-tablet");
        reset(await ana.sync());
        reset(await ben.sync());
        await fixture.ok("ben-phone", "/queue/active", "PUT", {
          setId: "set-1",
        });
        await fixture.ok(
          "ben-phone",
          "/presence/actions",
          "POST",
          play("set-1", 1)
        );
        expect(presenceOf(await ana.sync()).at(-1)).toEqual([
          { personId: "ben", setId: "set-1" },
        ]);
        await ben.sync();

        fixture.step(direction.name);
        const [hideKey, hideRoute, hideMethod, hidePayload] = direction.hide;
        await fixture.ok(hideKey, hideRoute, hideMethod, hidePayload);
        const hidden = reset(await ana.sync());
        expect(hidden.reset).toBe("access");
        expect(hidden.snapshot.presence).toEqual([]);
        expect(JSON.stringify(hidden)).not.toContain('"ben"');
        const people = (await fixture.ok("ana-phone", "/people")) as {
          people: { id: string }[];
        };
        expect(people.people.map((person) => person.id)).not.toContain("ben");
        expect(
          (await fixture.call("ana-phone", "/people/ben/listens")).status
        ).toBe(404);
        const benSide = await ben.sync();
        expect(benSide.kind).toBe(direction.symmetric ? "snapshot" : "changes");

        fixture.step("ben writes while hidden");
        const hiddenCursor = ana.cursor;
        await fixture.ok("ben-phone", "/queue/active", "PUT", {
          setId: "set-2",
        });
        await fixture.ok(
          "ben-phone",
          "/presence/actions",
          "POST",
          play("set-2", 2)
        );
        await fixture.ok("ben-phone", "/sets/set-2/tags", "PATCH", {
          tags: ["secret"],
        });
        const quietly = await ana.sync();
        quiet(quietly, hiddenCursor);
        expect(JSON.stringify(quietly)).not.toContain('"ben"');

        fixture.step("visibility returns");
        const [showKey, showRoute, showMethod, showPayload] = direction.show;
        await fixture.ok(showKey, showRoute, showMethod, showPayload);
        const shown = reset(await ana.sync());
        expect(shown.reset).toBe("access");
        expect(
          shown.snapshot.presence.map((entry) => ({
            personId: entry.personId,
            setId: entry.set.id,
          }))
        ).toEqual([{ personId: "ben", setId: "set-2" }]);
        const visible = (await fixture.ok("ana-phone", "/people")) as {
          people: { id: string }[];
        };
        expect(visible.people.map((person) => person.id)).toContain("ben");
        const after = await ana.sync();
        expect(invalidations(after)).toEqual([]);
        await fixture.ok("ben-phone", "/queue/active", "PUT", {
          setId: "set-3",
        });
        expect(invalidations(await ana.sync())).toEqual([
          { resourceId: "ben", topic: "listen-history" },
        ]);
      } finally {
        await fixture.stop();
      }
    });
  });
}

test("the initial snapshot and replay agree with HTTP for every visibility combination", async () => {
  await withRoot("resolver-matrix.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    try {
      for (const key of ["ben-phone", "cai-phone"] as const) {
        const set = key === "ben-phone" ? "set-1" : CAI_SET;
        await fixture.ok(key, "/queue/active", "PUT", { setId: set });
        await fixture.ok(key, "/presence/actions", "POST", play(set, 1));
      }
      const ana = fixture.client("ana-phone");
      reset(await ana.sync());
      const filters = [
        { appear: true, see: true },
        { appear: true, see: false },
        { appear: false, see: true },
      ];
      for (const anaFilter of filters) {
        for (const caiFilter of filters) {
          fixture.step(
            `ana ${JSON.stringify(anaFilter)} cai ${JSON.stringify(caiFilter)}`
          );
          await fixture.ok(
            "ana-phone",
            "/people/cai/filters",
            "PUT",
            anaFilter
          );
          await fixture.ok(
            "cai-phone",
            "/people/ana/filters",
            "PUT",
            caiFilter
          );
          const people = (await fixture.ok("ana-phone", "/people")) as {
            people: { id: string }[];
          };
          const httpVisible = sorted(people.people.map((person) => person.id));
          const initial = reset(await fixture.catchUp("ana-phone", null));
          const fromInitial = sorted(
            initial.snapshot.presence.map((entry) => entry.personId)
          );
          expect(fromInitial).toEqual(
            httpVisible.filter((id) => id !== "host")
          );
          const replay = await ana.sync();
          const replayed = presenceOf(replay).at(-1);
          if (replayed !== undefined) {
            expect(sorted(replayed.map((entry) => entry.personId))).toEqual(
              fromInitial
            );
          }
          if (!fromInitial.includes("cai")) {
            expect(JSON.stringify(initial)).not.toContain('"cai"');
            expect(JSON.stringify(replay)).not.toContain('"cai"');
          }
        }
      }
    } finally {
      await fixture.stop();
    }
  });
});

test("Playlist edits reach readable editors, and editor removal resets without the Playlist", async () => {
  await withRoot("playlists.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    try {
      const anaLaptop = fixture.client("ana-laptop");
      const ben = fixture.client("ben-tablet");
      const cai = fixture.client("cai-phone");
      const playlist = (await fixture.ok("ana-phone", "/playlists", "POST", {
        name: "Shared",
      })) as { id: string };
      await fixture.ok(
        "ana-phone",
        `/playlists/${playlist.id}/collaboration`,
        "PUT",
        { collaborative: true }
      );
      for (const device of [anaLaptop, ben, cai]) {
        reset(await device.sync());
      }

      fixture.step("ana adds ben as an editor");
      await fixture.ok(
        "ana-phone",
        `/playlists/${playlist.id}/editors`,
        "PUT",
        {
          editorIds: ["ben"],
        }
      );
      expect(reset(await ben.sync()).reset).toBe("access");

      fixture.step("ben edits");
      await fixture.ok("ben-phone", `/playlists/${playlist.id}/sets`, "PUT", {
        setIds: ["set-1", "set-2"],
      });
      expect(invalidations(await anaLaptop.sync())).toEqual([
        { resourceId: playlist.id, topic: "playlist" },
      ]);
      expect(invalidations(await ben.sync())).toEqual([
        { resourceId: playlist.id, topic: "playlist" },
      ]);
      const caiCursor = cai.cursor;
      quiet(await cai.sync(), caiCursor);

      fixture.step("ana removes ben");
      await fixture.ok(
        "ana-phone",
        `/playlists/${playlist.id}/editors`,
        "PUT",
        {
          editorIds: [],
        }
      );
      const removed = reset(await ben.sync());
      expect(removed.reset).toBe("access");
      expect(JSON.stringify(removed)).not.toContain(playlist.id);
      await fixture.ok("ana-phone", `/playlists/${playlist.id}/sets`, "PUT", {
        setIds: ["set-3"],
      });
      const later = ben.cursor;
      const benLater = await ben.sync();
      quiet(benLater, later);
      expect(JSON.stringify(benLater)).not.toContain(playlist.id);
      expect(
        (await fixture.call("ben-phone", `/playlists/${playlist.id}`)).status
      ).toBe(404);

      fixture.step("collaboration off resets a remaining editor");
      await fixture.ok(
        "ana-phone",
        `/playlists/${playlist.id}/editors`,
        "PUT",
        {
          editorIds: ["ben"],
        }
      );
      reset(await ben.sync());
      await fixture.ok(
        "ana-phone",
        `/playlists/${playlist.id}/collaboration`,
        "PUT",
        { collaborative: false }
      );
      expect(reset(await ben.sync()).reset).toBe("access");
    } finally {
      await fixture.stop();
    }
  });
});

test("revoking a key closes its feed and clears its Presence in one commit", async () => {
  await withRoot("revocation.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    try {
      const ben = fixture.client("ben-phone");
      const phone = fixture.client("ana-phone");
      reset(await phone.sync());
      await fixture.ok("ana-phone", "/queue/active", "PUT", { setId: "set-1" });
      await fixture.ok(
        "ana-phone",
        "/presence/actions",
        "POST",
        play("set-1", 1)
      );
      reset(await ben.sync());
      expect(ben.cursor).not.toBeNull();

      fixture.step("a failed Presence clear leaves the key working");
      const sqlite = new Database(databasePath);
      try {
        sqlite.run(
          "CREATE TRIGGER fail_presence_clear BEFORE DELETE ON presence_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END"
        );
        expect(
          (await fixture.call("ana-laptop", "/me/devices/ana-phone", "DELETE"))
            .status
        ).toBe(500);
        expect((await fixture.call("ana-phone", "/me")).status).toBe(200);
        expect((await phone.sync()).kind).toBe("changes");
        sqlite.run("DROP TRIGGER fail_presence_clear");
      } finally {
        sqlite.close();
      }

      fixture.step("revoke from the laptop");
      const beforeRevoke = fixture.notices.length;
      await fixture.ok("ana-laptop", "/me/devices/ana-phone", "DELETE");
      expect(fixture.notices.slice(beforeRevoke)).toContainEqual({
        keyId: "ana-phone",
        kind: "revoked",
      });
      expect(await phone.sync()).toEqual({ kind: "closed" });
      expect(presenceOf(await ben.sync()).at(-1)).toEqual([]);
      expect((await fixture.call("ana-phone", "/me")).status).toBe(401);

      fixture.step("admin revokes ben's tablet");
      const tablet = fixture.client("ben-tablet");
      reset(await tablet.sync());
      await fixture.ok("admin", "/admin/keys/ben-tablet", "DELETE");
      expect(await tablet.sync()).toEqual({ kind: "closed" });
      expect(fixture.notices).toContainEqual({
        keyId: "ben-tablet",
        kind: "revoked",
      });

      fixture.step("removing a Person closes their feed and resets viewers");
      const cai = fixture.client("cai-phone");
      reset(await cai.sync());
      await ben.sync();
      await fixture.ok("admin", "/admin/people/cai", "DELETE");
      expect(await cai.sync()).toEqual({ kind: "closed" });
      const viewer = reset(await ben.sync());
      expect(viewer.reset).toBe("access");
      expect(JSON.stringify(viewer)).not.toContain('"cai"');
    } finally {
      await fixture.stop();
    }
  });
});

test("a mutation and its deliveries commit or roll back together", async () => {
  await withRoot("rollback.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    const sqlite = new Database(databasePath);
    try {
      const laptop = fixture.client("ana-laptop");
      reset(await laptop.sync());

      fixture.step("the delivery insert fails");
      sqlite.run(
        "CREATE TRIGGER fail_delivery BEFORE INSERT ON feed_deliveries BEGIN SELECT RAISE(ABORT, 'injected'); END"
      );
      expect(
        (
          await fixture.call("ana-phone", "/sets/set-1/tags", "PATCH", {
            tags: ["lost"],
          })
        ).status
      ).toBe(500);
      expect(
        (
          await fixture.call("ana-phone", "/queue/active", "PUT", {
            setId: "set-1",
          })
        ).status
      ).toBe(500);
      sqlite.run("DROP TRIGGER fail_delivery");
      const sets = (await fixture.ok("ana-phone", "/sets")) as {
        sets: { id: string; tags: string[] }[];
      };
      expect(sets.sets.find((set) => set.id === "set-1")?.tags).toEqual([]);
      const queue = (await fixture.ok("ana-phone", "/queue")) as {
        queue: { activeSetId: string | null };
      };
      expect(queue.queue.activeSetId).toBeNull();

      fixture.step("the Listen insert fails after the Queue write");
      sqlite.run(
        "CREATE TRIGGER fail_listen BEFORE INSERT ON listens BEGIN SELECT RAISE(ABORT, 'injected'); END"
      );
      const before = laptop.cursor;
      expect(
        (
          await fixture.call("ana-phone", "/queue/active", "PUT", {
            setId: "set-2",
          })
        ).status
      ).toBe(500);
      sqlite.run("DROP TRIGGER fail_listen");
      const unchanged = (await fixture.ok("ana-phone", "/queue")) as {
        queue: { activeSetId: string | null };
      };
      expect(unchanged.queue.activeSetId).toBeNull();
      quiet(await laptop.sync(), before);

      fixture.step("the mutation succeeds once the fault is gone");
      await fixture.ok("ana-phone", "/queue/active", "PUT", { setId: "set-2" });
      const kinds = changes(await laptop.sync()).map(
        (delivery) => delivery.body.kind
      );
      expect(kinds).toContain("queue");
    } finally {
      sqlite.close();
      await fixture.stop();
    }
  });
});

test("a snapshot boundary loses no write that commits around it", async () => {
  await withRoot(
    "snapshot-boundary.json",
    async (_root, databasePath, trace) => {
      const fixture = start(databasePath, trace);
      try {
        fixture.step("reconnect at the boundary");
        const first = reset(await fixture.catchUp("ana-laptop", null));
        await fixture.ok("ana-phone", "/queue/entries", "POST", {
          placement: "end",
          setId: "set-1",
        });
        const next = changes(
          await fixture.catchUp("ana-laptop", first.snapshot.cursor)
        );
        expect(next.map((delivery) => delivery.body.kind)).toEqual(["queue"]);

        fixture.step("snapshots race queue writes");
        const writes = ["set-2", "set-3", "set-1", "set-2"].map(
          (setId, index) =>
            fixture.ok("ana-phone", "/queue/entries", "POST", {
              placement: index % 2 === 0 ? "end" : "next",
              setId,
            })
        );
        const snapshots = Array.from({ length: 6 }, () =>
          fixture.catchUp("ana-laptop", null)
        );
        await Promise.all(writes);
        const final = (await fixture.ok("ana-phone", "/queue")) as {
          queue: ListeningQueue;
        };
        for (const pending of snapshots) {
          const taken = reset(await pending);
          const replay = changes(
            await fixture.catchUp("ana-laptop", taken.snapshot.cursor)
          );
          const latest = [...replay]
            .reverse()
            .find((delivery) => delivery.body.kind === "queue");
          const converged =
            latest?.body.kind === "queue"
              ? latest.body.queue
              : taken.snapshot.queue;
          expect(converged).toEqual(final.queue);
        }
      } finally {
        await fixture.stop();
      }
    }
  );
});

test("retention and stale cursors answer reset", async () => {
  await withRoot("retention.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace, {
      feed: { retentionCount: 5, retentionMs: 1500 },
    });
    try {
      const laptop = fixture.client("ana-laptop");
      reset(await laptop.sync());
      const oldest = laptop.cursor;

      fixture.step("more than the count bound");
      for (const tag of ["a", "b", "c", "d", "e", "f"]) {
        await fixture.ok("ana-phone", "/sets/set-1/tags", "PATCH", {
          tags: [tag],
        });
        await fixture.ok("ana-phone", "/sets/set-2/tags", "PATCH", {
          tags: [tag],
        });
      }
      expect(reset(await fixture.catchUp("ana-laptop", oldest)).reset).toBe(
        "expired"
      );
      const recent = reset(await fixture.catchUp("ana-laptop", null)).snapshot
        .cursor;
      await fixture.ok("ana-phone", "/sets/set-3/tags", "PATCH", {
        tags: ["g"],
      });
      expect(
        invalidations(await fixture.catchUp("ana-laptop", recent))
      ).toEqual([{ resourceId: "set-3", topic: "library" }]);

      fixture.step("older than the age bound");
      await Bun.sleep(1700);
      expect(reset(await fixture.catchUp("ana-laptop", recent)).reset).toBe(
        "expired"
      );

      fixture.step("cursors that do not belong to the caller");
      const phoneCursor = reset(await fixture.catchUp("ana-phone", null))
        .snapshot.cursor;
      expect(
        reset(await fixture.catchUp("ana-laptop", phoneCursor)).reset
      ).toBe("invalid");
      expect(reset(await fixture.catchUp("ben-phone", phoneCursor)).reset).toBe(
        "invalid"
      );
      expect(
        reset(await fixture.catchUp("ana-laptop", "not-a-cursor")).reset
      ).toBe("invalid");
      const beforeEpoch = reset(await fixture.catchUp("ana-laptop", null))
        .snapshot.cursor;
      await fixture.ok("ana-phone", "/people/ben/filters", "PUT", {
        see: false,
      });
      expect(
        reset(await fixture.catchUp("ana-laptop", beforeEpoch)).reset
      ).toBe("access");
    } finally {
      await fixture.stop();
    }
  });
});

test("a restored backup answers reset to cursors from after the backup", async () => {
  await withRoot("restore.json", async (root, databasePath, trace) => {
    const backup = path.join(root, "backup.sqlite");
    let fixture = start(databasePath, trace);
    let early: string | null = null;
    let late: string | null = null;
    try {
      const laptop = fixture.client("ana-laptop");
      reset(await laptop.sync());
      await fixture.ok("ana-phone", "/sets/set-1/tags", "PATCH", {
        tags: ["a"],
      });
      await laptop.sync();
      early = laptop.cursor;
      fixture.step("back up");
      const sqlite = new Database(databasePath);
      try {
        sqlite.run(`VACUUM INTO '${backup}'`);
      } finally {
        sqlite.close();
      }
      for (const tag of ["b", "c"]) {
        await fixture.ok("ana-phone", "/sets/set-2/tags", "PATCH", {
          tags: [tag],
        });
      }
      await laptop.sync();
      late = laptop.cursor;
    } finally {
      await fixture.stop();
    }

    fixture.step("restore");
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await copyFile(backup, databasePath);
    fixture = start(databasePath, trace);
    try {
      expect(reset(await fixture.catchUp("ana-laptop", late)).reset).toBe(
        "invalid"
      );
      expect((await fixture.catchUp("ana-laptop", early)).kind).toBe("changes");
      for (const tag of ["x", "y", "z"]) {
        await fixture.ok("ana-phone", "/sets/set-3/tags", "PATCH", {
          tags: [tag],
        });
      }
      expect(reset(await fixture.catchUp("ana-laptop", late)).reset).toBe(
        "invalid"
      );
      expect(invalidations(await fixture.catchUp("ana-laptop", early))).toEqual(
        [{ resourceId: "set-3", topic: "library" }]
      );
    } finally {
      await fixture.stop();
    }
  });
});

test("a Set invalidation is withheld once the recipient can no longer read the Set", async () => {
  await withRoot("filtered-replay.json", async (_root, databasePath, trace) => {
    const fixture = start(databasePath, trace);
    try {
      const sqlite = new Database(databasePath);
      try {
        sqlite.run(
          "INSERT INTO library_entries (person_id, set_id, saved_at, tags) VALUES ('ben', ?, '2026-10-01T00:00:00.000Z', '[]')",
          [CAI_SET]
        );
      } finally {
        sqlite.close();
      }
      await fixture.ok("cai-phone", "/people/ana/filters", "PUT", {
        appear: false,
      });
      const ana = fixture.client("ana-phone");
      reset(await ana.sync());

      fixture.step("cai's Set metadata changes while ana reads it through ben");
      await fixture.ok("cai-phone", `/sets/${CAI_SET}/metadata`, "POST");
      expect(invalidations(await ana.sync())).toEqual([
        { resourceId: CAI_SET, topic: "set" },
      ]);

      fixture.step("ben removes the Set before ana catches up");
      const before = ana.cursor;
      await fixture.ok("cai-phone", `/sets/${CAI_SET}/metadata`, "POST");
      await fixture.ok("ben-phone", `/sets/${CAI_SET}`, "DELETE");
      const replay = await fixture.catchUp("ana-phone", before);
      expect(changes(replay)).toEqual([]);
      expect(JSON.stringify(replay)).not.toContain(CAI_SET);
      expect(JSON.stringify(replay)).not.toContain('"cai"');
    } finally {
      await fixture.stop();
    }
  });
});
