import { expect, test } from "bun:test";

import { Effect } from "effect";

import type { RunYtDlp } from "./ytdlp-metadata.js";
import { ytDlpMetadata } from "./ytdlp-metadata.js";

const read = (run: RunYtDlp, url = "https://soundcloud.com/a/b") =>
  Effect.runPromise(
    Effect.result(ytDlpMetadata({ binPath: "/opt/yt-dlp", run }).read(url))
  );

const SOUNDCLOUD = {
  description: " Recorded live. ",
  duration: 3600.4,
  genre: "House",
  tags: ["house", " house ", "live", ""],
  thumbnail: "https://example.test/art.jpg",
  title: " Live at the Warehouse ",
  upload_date: "20260214",
  uploader: "Ada",
  uploader_id: "1234",
  uploader_url: "https://soundcloud.com/ada",
};

test("maps a SoundCloud dump to source details", async () => {
  const result = await read(() => Promise.resolve(JSON.stringify(SOUNDCLOUD)));
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") {
    return;
  }
  expect(result.success).toEqual({
    chapters: [],
    creator: "Ada",
    creatorId: "1234",
    creatorUrl: "https://soundcloud.com/ada",
    description: "Recorded live.",
    durationSeconds: 3600,
    genre: "House",
    releasedAt: "2026-02-14T00:00:00.000Z",
    tags: ["house", "live"],
    thumbnailUrl: "https://example.test/art.jpg",
    title: "Live at the Warehouse",
  });
});

test("prefers the YouTube channel over the uploader and keeps chapters", async () => {
  const result = await read(() =>
    Promise.resolve(
      JSON.stringify({
        channel: "Boiler Room",
        channel_id: "UC1",
        chapters: [
          { end_time: 60, start_time: 0, title: "Intro" },
          { end_time: 120, start_time: 60, title: " " },
        ],
        timestamp: 1_760_000_000,
        title: "Set",
        uploader: "Someone else",
      })
    )
  );
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") {
    return;
  }
  expect(result.success.creator).toBe("Boiler Room");
  expect(result.success.creatorId).toBe("UC1");
  expect(result.success.chapters).toEqual([
    { startSeconds: 0, title: "Intro" },
  ]);
  expect(result.success.releasedAt).toBe("2025-10-09T08:53:20.000Z");
});

test("passes the URL after `--` so it cannot be read as a flag", async () => {
  let seen: readonly string[] = [];
  await read((_bin, args) => {
    seen = args;
    return Promise.resolve(JSON.stringify(SOUNDCLOUD));
  }, "--exec=evil");
  expect(seen.slice(-2)).toEqual(["--", "--exec=evil"]);
});

test("fails as provider-unavailable when yt-dlp exits non-zero", async () => {
  const result = await read(() => Promise.resolve(null));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure.reason).toBe("provider-unavailable");
  }
});

test.each([["not json"], [JSON.stringify({ uploader: "Ada" })]])(
  "fails as unexpected-response on %s",
  async (output) => {
    const result = await read(() => Promise.resolve(output));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("unexpected-response");
    }
  }
);

test("decodes HTML entities in the description and turns nbsp into a space", async () => {
  const result = await read(() =>
    Promise.resolve(
      JSON.stringify({
        ...SOUNDCLOUD,
        description:
          "Ada&nbsp;&amp;&#32;Bob&#39;s &quot;set&quot; &#x41; &amp;lt; &bogus; &#0;\u00A0live",
      })
    )
  );
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") {
    expect(result.success.description).toBe(
      `Ada & Bob's "set" A &lt; &bogus; &#0; live`
    );
  }
});

test("never runs more yt-dlp processes than maxConcurrent", async () => {
  let active = 0;
  let peak = 0;
  const run: RunYtDlp = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(20);
    active -= 1;
    return JSON.stringify(SOUNDCLOUD);
  };
  const service = ytDlpMetadata({
    binPath: "/opt/yt-dlp",
    maxConcurrent: 2,
    run,
  });
  const results = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 5 }, () =>
        Effect.result(service.read("https://soundcloud.com/a/b"))
      ),
      { concurrency: "unbounded" }
    )
  );
  expect(results.every((result) => result._tag === "Success")).toBe(true);
  expect(peak).toBe(2);
});
