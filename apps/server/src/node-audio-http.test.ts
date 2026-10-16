import { expect, setSystemTime, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WideEvent } from "evlog";

import { makeNodeAudioHandler } from "./node-audio-http.js";
import { grantSecret, issueStreamGrant } from "./stream-grant.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A grant signed with the right secret but issued at another time. */
const grantIssuedAt = (secret: Buffer, setId: string, at: number) => {
  setSystemTime(new Date(at));
  try {
    return issueStreamGrant(secret, setId, "host");
  } finally {
    setSystemTime();
  }
};

test("the audio node records one wide event per request, with the grant verdict and never the grant", async () => {
  const audioDir = await mkdtemp(path.join(tmpdir(), "orbis-node-events-"));
  const fixture = path.resolve(
    import.meta.dir,
    "../../../scripts/fixtures/ready-set.m4a"
  );
  await copyFile(fixture, path.join(audioDir, "fixture.m4a"));
  const { size } = Bun.file(fixture);
  const streamSecret = grantSecret(path.join(audioDir, "stream-grant.key"));
  const grant = issueStreamGrant(streamSecret, "fixture", "host");
  const expired = grantIssuedAt(
    streamSecret,
    "fixture",
    Date.now() - 2 * DAY_MS
  );
  const ahead = grantIssuedAt(streamSecret, "fixture", Date.now() + DAY_MS);
  const events: WideEvent[] = [];
  const audio = makeNodeAudioHandler({
    audioDir,
    logging: { onEvent: (event) => events.push(event), silent: true },
    streamSecret,
  });
  const send = async (target: string, init?: RequestInit) => {
    const response = await audio(new Request(`http://node${target}`, init));
    await response.arrayBuffer();
    return response.status;
  };
  try {
    const statuses = [
      await send(`/api/sets/fixture/audio?grant=${grant}`),
      await send(`/api/sets/fixture/audio?grant=${grant}`, {
        headers: { range: "bytes=7-22" },
      }),
      await send(`/sets/fixture/audio?grant=${grant}`, {
        headers: { range: `bytes=${size}-` },
      }),
      await send(
        `/sets/absent/audio?grant=${issueStreamGrant(streamSecret, "absent", "host")}`
      ),
      await send("/sets/fixture/audio"),
      await send("/sets/fixture/audio?grant=altered"),
      await send(`/sets/another/audio?grant=${grant}`),
      await send(`/sets/fixture/audio?grant=${expired}`),
      await send(`/sets/fixture/audio?grant=${ahead}`),
    ];
    expect(statuses).toEqual([200, 206, 416, 404, 401, 401, 401, 401, 401]);
    expect(events.map((event) => event.ingress)).toEqual(
      statuses.map(() => "funnel-audio")
    );
    expect(events.map((event) => event.status)).toEqual(statuses);
    expect(events.map((event) => event.audio)).toEqual([
      {
        bytes: size,
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        set: "fixture",
        size,
      },
      {
        bytes: 16,
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        range: "bytes=7-22",
        set: "fixture",
        size,
      },
      {
        file: "found",
        format: "m4a",
        grant: "valid",
        person: "host",
        range: `bytes=${size}-`,
        set: "fixture",
        size,
      },
      { file: "missing", grant: "valid", person: "host", set: "absent" },
      { grant: "missing", set: "fixture" },
      { grant: "malformed", set: "fixture" },
      { grant: "bad-signature", set: "another" },
      { grant: "expired", set: "fixture" },
      { grant: "future-expiry", set: "fixture" },
    ]);
    expect(events.every((event) => event.duration !== undefined)).toBe(true);
    const logged = JSON.stringify(events);
    for (const secret of [grant, expired, ahead, "altered"]) {
      expect(logged).not.toContain(secret);
    }
  } finally {
    await rm(audioDir, { force: true, recursive: true });
  }
});

test("the audio node checks grants before keys and serves full, ranged, and HEAD audio", async () => {
  const audioDir = await mkdtemp(path.join(tmpdir(), "orbis-node-audio-"));
  const fixture = path.resolve(
    import.meta.dir,
    "../../../scripts/fixtures/ready-set.m4a"
  );
  await copyFile(fixture, path.join(audioDir, "fixture.m4a"));
  const streamSecret = grantSecret(path.join(audioDir, "stream-grant.key"));
  const grant = issueStreamGrant(streamSecret, "fixture", "host");
  const server = Bun.serve({
    fetch: makeNodeAudioHandler({ audioDir, streamSecret }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const url = new URL(`/sets/fixture/audio?grant=${grant}`, server.url);
  try {
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mp4");
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(bytes.length).toBe(Bun.file(fixture).size);
    const range = await fetch(url, { headers: { range: "bytes=7-22" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 7-22/${bytes.length}`
    );
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(
      bytes.slice(7, 23)
    );
    const suffix = await fetch(url, { headers: { range: "bytes=-16" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      bytes.slice(-16)
    );
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
    expect(await head.text()).toBe("");
    const beyond = await fetch(url, {
      headers: { range: `bytes=${bytes.length}-` },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    await beyond.text();
    const withKey = await fetch(url, {
      headers: { authorization: "Bearer invalid" },
    });
    expect(withKey.status).toBe(200);
    await withKey.arrayBuffer();
    const rejected = await Promise.all([
      fetch(new URL("/sets/fixture/audio", server.url), {
        headers: { authorization: "Bearer valid-looking" },
      }),
      fetch(new URL("/sets/fixture/audio?grant=altered", server.url)),
      fetch(new URL(`/sets/another/audio?grant=${grant}`, server.url)),
      fetch(
        new URL(
          `/sets/fixture/audio?grant=${grant.replace(/^\d+/u, "1000000000000")}`,
          server.url
        )
      ),
      fetch(new URL("/sets/fixture/audio?grant=invalid", server.url), {
        headers: { authorization: "Bearer valid-looking" },
      }),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    await Promise.all(rejected.map((response) => response.text()));
    const nongrant = await fetch(new URL("/health", server.url));
    expect(nongrant.status).toBe(404);
    await nongrant.text();
  } finally {
    await server.stop(true);
    await rm(audioDir, { force: true, recursive: true });
  }
});
