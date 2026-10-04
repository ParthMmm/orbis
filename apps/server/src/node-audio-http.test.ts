import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeNodeAudioHandler } from "./node-audio-http.js";
import { grantSecret, issueStreamGrant } from "./stream-grant.js";

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
