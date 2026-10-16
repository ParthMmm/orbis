import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WideEvent } from "evlog";

import { issueStreamGrant } from "./stream-grant.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { seedSets } from "./test-library.js";

test("the audio route records why it refused, without the grant", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-audio-events-"));
  const databasePath = path.join(directory, "library.sqlite");
  const events: WideEvent[] = [];
  try {
    await seedSets(databasePath, [{ downloadState: "queued", id: "pending" }]);
    const app = createApp({
      databasePath,
      logging: { onEvent: (event) => events.push(event), silent: true },
    });
    const forged = issueStreamGrant(randomBytes(32), "pending", "host");
    try {
      const statuses = [
        await request(app, { method: "GET", url: "/sets/absent/audio" }),
        await request(app, { method: "GET", url: "/sets/pending/audio" }),
        await request(app, {
          method: "GET",
          url: `/sets/pending/audio?grant=${forged}`,
        }),
        await request(app, {
          method: "GET",
          url: "/sets/pending/audio?grant=truncated",
        }),
      ].map((response) => response.statusCode);
      expect(statuses).toEqual([404, 404, 401, 401]);
    } finally {
      await app.dispose();
    }
    const audioEvents = events.filter((event) =>
      String(event.path).endsWith("/audio")
    );
    expect(audioEvents.map((event) => event.audio)).toEqual([
      {
        person: "host",
        reason: "set-not-found",
        result: "refused",
        set: "absent",
      },
      {
        downloadState: "queued",
        person: "host",
        reason: "no-audio",
        result: "refused",
        set: "pending",
      },
      {
        grant: "bad-signature",
        reason: "grant-refused",
        result: "refused",
        set: "pending",
      },
      {
        grant: "malformed",
        reason: "grant-refused",
        result: "refused",
        set: "pending",
      },
    ]);
    expect(audioEvents.map((event) => event.status)).toEqual([
      404, 404, 401, 401,
    ]);
    expect(JSON.stringify(events)).not.toContain(forged);
    expect(JSON.stringify(events)).not.toContain("truncated");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
