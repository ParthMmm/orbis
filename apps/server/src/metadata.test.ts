import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SavedSetSchema } from "@orbis/contracts/http-api";
import { Effect, Schema } from "effect";

import { MetadataError } from "./metadata-error.js";
import type {
  EnrichedMetadata,
  EnrichInput,
  MetadataOptions,
  MetadataService,
} from "./metadata.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import type { SourceDetails, YtDlpMetadataService } from "./ytdlp-metadata.js";

const PROVIDER_RESULT: EnrichedMetadata = {
  artworkLargeUrl: "https://example.test/artwork.jpg",
  artworkUrl: "https://example.test/artwork.jpg",
  creator: "Ada Lovelace",
  durationSeconds: 253,
  releasedAt: "2015-10-28T10:00:00.000Z",
  title: "Analytical Engine live",
};

const providerDown = () =>
  new MetadataError({
    message: "The provider is unreachable.",
    reason: "provider-unavailable",
  });

type Enrich = (
  input: EnrichInput
) => Effect.Effect<EnrichedMetadata, MetadataError>;

const startApp = async (
  enrich: Enrich,
  extra: { details?: MetadataService["details"] } = {}
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-metadata-"));
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    metadata: Metadata.layerOf({ enrich, ...extra }),
  });
  return {
    app,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
  };
};

const saveSet = (app: ReturnType<typeof createApp>, url: string) =>
  request(app, {
    method: "POST",
    payload: { tags: ["mix"], url },
    url: "/sets",
  });

test("fills title, creator, artwork, and duration from the provider when the save omits a title", async () => {
  const server = await startApp(() => Effect.succeed(PROVIDER_RESULT));
  try {
    const saved = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toEqual({
      artworkLargeUrl: "https://example.test/artwork.jpg",
      artworkUrl: "https://example.test/artwork.jpg",
      autoDownloadResult: "unavailable",
      createdAt: expect.any(String),
      creator: "Ada Lovelace",
      creatorId: null,
      downloadState: "none",
      durationSeconds: 253,
      finishCount: 0,
      id: expect.any(String),
      lastListenedAt: null,
      listenCount: 0,
      metadataState: "enriched",
      playbackPositionSeconds: 0,
      playlistIds: [],
      releasedAt: "2015-10-28T10:00:00.000Z",
      retainedAudioBytes: null,
      retainedAudioFormat: null,
      source: "youtube",
      tags: ["mix"],
      title: "Analytical Engine live",
      titleEditedByUser: false,
      tracklistState: "pending",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
  } finally {
    await server.dispose();
  }
});

test("keeps the title the user supplied and asks no provider for it", async () => {
  const server = await startApp(() => Effect.fail(providerDown()));
  try {
    const saved = await request(server.app, {
      method: "POST",
      payload: {
        tags: ["mix"],
        title: "  My own title  ",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      creator: null,
      durationSeconds: null,
      metadataState: "pending",
      title: "My own title",
      titleEditedByUser: true,
    });
  } finally {
    await server.dispose();
  }
});

test("records unknown creator, artwork, and duration after a failed enrichment", async () => {
  const server = await startApp(() => Effect.fail(providerDown()));
  try {
    const saved = await saveSet(
      server.app,
      "https://soundcloud.com/artist/track"
    );
    expect(saved.json()).toMatchObject({
      artworkLargeUrl: null,
      artworkUrl: null,
      creator: null,
      durationSeconds: null,
      metadataState: "failed",
      source: "soundcloud",
      title: "SoundCloud track",
    });

    const library = await request(server.app, { method: "GET", url: "/sets" });
    expect(library.json()).toEqual({
      sets: [Schema.decodeUnknownSync(SavedSetSchema)(saved.json())],
    });
  } finally {
    await server.dispose();
  }
});

test("retry replaces the temporary title that no user edited", async () => {
  let provider: Effect.Effect<EnrichedMetadata, MetadataError> =
    Effect.fail(providerDown());
  const server = await startApp(() => provider);
  try {
    const saved = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.json().title).toBe("YouTube video");
    provider = Effect.succeed(PROVIDER_RESULT);

    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${String(saved.json().id)}/metadata`,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({
      ...Schema.decodeUnknownSync(SavedSetSchema)(saved.json()),
      artworkLargeUrl: "https://example.test/artwork.jpg",
      artworkUrl: "https://example.test/artwork.jpg",
      creator: "Ada Lovelace",
      durationSeconds: 253,
      metadataState: "enriched",
      releasedAt: "2015-10-28T10:00:00.000Z",
      title: "Analytical Engine live",
    });
  } finally {
    await server.dispose();
  }
});

test("retry keeps the title a user edited and fills the rest in", async () => {
  let provider: Effect.Effect<EnrichedMetadata, MetadataError> =
    Effect.fail(providerDown());
  const server = await startApp(() => provider);
  try {
    const saved = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    const edited = await request(server.app, {
      method: "PATCH",
      payload: { title: "Hand written" },
      url: `/sets/${String(saved.json().id)}/title`,
    });
    expect(edited.json()).toMatchObject({
      title: "Hand written",
      titleEditedByUser: true,
    });
    provider = Effect.succeed(PROVIDER_RESULT);

    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${String(saved.json().id)}/metadata`,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({
      ...edited.json(),
      artworkLargeUrl: "https://example.test/artwork.jpg",
      artworkUrl: "https://example.test/artwork.jpg",
      creator: "Ada Lovelace",
      durationSeconds: 253,
      metadataState: "enriched",
      releasedAt: "2015-10-28T10:00:00.000Z",
    });
  } finally {
    await server.dispose();
  }
});

test("finds a set by creator through the existing text search", async () => {
  const server = await startApp(({ source }) =>
    Effect.succeed(
      source === "youtube"
        ? PROVIDER_RESULT
        : { ...PROVIDER_RESULT, creator: "Grace Hopper" }
    )
  );
  try {
    const youtube = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    await saveSet(server.app, "https://soundcloud.com/artist/track");

    const byCreator = await request(server.app, {
      method: "GET",
      url: "/sets?q=lovelace",
    });
    expect(byCreator.json().sets).toEqual([
      Schema.decodeUnknownSync(SavedSetSchema)(youtube.json()),
    ]);
    const caseInsensitive = await request(server.app, {
      method: "GET",
      url: "/sets?q=HOPPER&source=soundcloud",
    });
    expect(caseInsensitive.json().sets).toHaveLength(1);
    const absent = await request(server.app, {
      method: "GET",
      url: "/sets?q=Turing",
    });
    expect(absent.json().sets).toEqual([]);
  } finally {
    await server.dispose();
  }
});

const respondWith =
  <A>(body: A, status = 200) =>
  () =>
    Promise.resolve(Response.json(body, { status }));

const enrichWith = (options: MetadataOptions, input: EnrichInput) =>
  Effect.runPromise(
    Effect.gen(function* runEnrich() {
      const metadata = yield* Metadata;
      return yield* metadata.enrich(input);
    }).pipe(Effect.provide(Metadata.layer(options)))
  );

const reasonFrom = (options: MetadataOptions, input: EnrichInput) =>
  Effect.runPromise(
    Effect.flip(
      Effect.gen(function* runEnrich() {
        const metadata = yield* Metadata;
        return yield* metadata.enrich(input);
      }).pipe(Effect.provide(Metadata.layer(options)))
    )
  );

interface Thumbnails {
  default?: { url: string };
  high?: { url: string };
  maxres?: { url: string };
  medium?: { url: string };
  standard?: { url: string };
}

const youTubeBody = (thumbnails: Thumbnails) => ({
  items: [
    {
      contentDetails: { duration: "PT4M13S" },
      snippet: {
        channelTitle: "Ada Lovelace",
        publishedAt: "2015-10-28T10:00:00.000Z",
        thumbnails,
        title: "Analytical Engine live",
      },
    },
  ],
});

const thumbnailURL = (name: string) => ({
  url: `https://example.test/${name}.jpg`,
});

const YouTubeVideo = youTubeBody({
  default: { url: "https://example.test/default.jpg" },
});

test("reads the documented YouTube Data API fields into metadata", async () => {
  const requested: string[] = [];
  const metadata = await enrichWith(
    {
      fetch: (url) => {
        requested.push(url);
        return respondWith(YouTubeVideo)();
      },
      youTubeApiKey: "test-key",
    },
    { source: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" }
  );

  expect(metadata).toEqual({
    artworkLargeUrl: "https://example.test/default.jpg",
    artworkUrl: "https://example.test/default.jpg",
    creator: "Ada Lovelace",
    durationSeconds: 253,
    releasedAt: "2015-10-28T10:00:00.000Z",
    title: "Analytical Engine live",
  });
  expect(requested).toEqual([
    "https://www.googleapis.com/youtube/v3/videos?id=abcdefghijk&key=test-key&part=snippet%2CcontentDetails",
  ]);
});

test("fills the listing image and the page image from one payload", async () => {
  const artworkOf = async (thumbnails: Thumbnails) => {
    const metadata = await enrichWith(
      {
        fetch: respondWith(youTubeBody(thumbnails)),
        youTubeApiKey: "test-key",
      },
      { source: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" }
    );
    return [metadata.artworkUrl, metadata.artworkLargeUrl];
  };

  // Each row offers one more image than the row above it. The listing image stays at the size a
  // row draws, so it lands on `medium` as soon as there is one and never climbs higher; the page
  // image takes the sharpest the video has.
  const ladder: [Thumbnails, string, string][] = [
    [
      {
        default: thumbnailURL("default"),
        high: thumbnailURL("high"),
        maxres: thumbnailURL("maxres"),
        medium: thumbnailURL("medium"),
        standard: thumbnailURL("standard"),
      },
      "medium",
      "maxres",
    ],
    [
      {
        default: thumbnailURL("default"),
        high: thumbnailURL("high"),
        medium: thumbnailURL("medium"),
        standard: thumbnailURL("standard"),
      },
      "medium",
      "standard",
    ],
    [
      {
        default: thumbnailURL("default"),
        high: thumbnailURL("high"),
        medium: thumbnailURL("medium"),
      },
      "medium",
      "high",
    ],
    [
      { default: thumbnailURL("default"), high: thumbnailURL("high") },
      "high",
      "high",
    ],
    [
      { default: thumbnailURL("default"), medium: thumbnailURL("medium") },
      "medium",
      "medium",
    ],
    [{ default: thumbnailURL("default") }, "default", "default"],
  ];

  const found = await Promise.all(
    ladder.map(([thumbnails]) => artworkOf(thumbnails))
  );
  expect(found).toEqual(
    ladder.map(([, listing, page]) => [
      `https://example.test/${listing}.jpg`,
      `https://example.test/${page}.jpg`,
    ])
  );
  expect(await artworkOf({})).toEqual([null, null]);
});

test("reads SoundCloud oEmbed and leaves the duration unknown", async () => {
  const requested: string[] = [];
  const metadata = await enrichWith(
    {
      fetch: (url) => {
        requested.push(url);
        return respondWith({
          author_name: "Grace Hopper",
          thumbnail_url: "https://example.test/hopper.jpg",
          title: "Compiler talk",
        })();
      },
    },
    { source: "soundcloud", url: "https://soundcloud.com/artist/track" }
  );

  expect(metadata).toEqual({
    artworkLargeUrl: "https://example.test/hopper.jpg",
    artworkUrl: "https://example.test/hopper.jpg",
    creator: "Grace Hopper",
    durationSeconds: null,
    releasedAt: null,
    title: "Compiler talk",
  });
  expect(requested).toEqual([
    "https://soundcloud.com/oembed?format=json&url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack",
  ]);
});

test("reports each provider failure with its own reason", async () => {
  const youtube: EnrichInput = {
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  };

  const unconfigured = await reasonFrom(
    { fetch: respondWith({ items: [] }) },
    youtube
  );
  expect(unconfigured.reason).toBe("not-configured");
  expect(unconfigured.message).toBe(
    "youtube enrichment is not configured on this server."
  );

  const refused = await reasonFrom(
    { fetch: respondWith({ error: "quota" }, 403), youTubeApiKey: "test-key" },
    youtube
  );
  expect(refused.reason).toBe("provider-rejected");

  const missing = await reasonFrom(
    { fetch: respondWith({ items: [] }), youTubeApiKey: "test-key" },
    youtube
  );
  expect(missing.reason).toBe("provider-rejected");
  expect(missing.message).toBe("YouTube does not have this video.");

  const unreadable = await reasonFrom(
    {
      fetch: respondWith({ items: [{ id: "abcdefghijk" }] }),
      youTubeApiKey: "test-key",
    },
    youtube
  );
  expect(unreadable.reason).toBe("unexpected-response");

  const idless = await reasonFrom(
    { fetch: respondWith(YouTubeVideo), youTubeApiKey: "test-key" },
    { source: "youtube", url: "https://www.youtube.com/" }
  );
  expect(idless.reason).toBe("unsupported-source");

  const offline = await reasonFrom(
    {
      fetch: () => Promise.reject(new Error("offline")),
      youTubeApiKey: "test-key",
    },
    youtube
  );
  expect(offline.reason).toBe("provider-unavailable");

  const unreachableSoundCloud = await reasonFrom(
    { fetch: () => Promise.reject(new Error("offline")) },
    { source: "soundcloud", url: "https://soundcloud.com/artist/track" }
  );
  expect(unreachableSoundCloud.reason).toBe("provider-unavailable");
});

// The fill runs after the response, so wait for it rather than assume it is done.
const waitFor = async <T extends object | null | undefined>(
  ready: () => boolean,
  read: () => T,
  attempts = 50
): Promise<T> => {
  if (ready() || attempts === 0) {
    return read();
  }
  await Bun.sleep(20);
  return waitFor(ready, read, attempts - 1);
};

const DETAILS: SourceDetails = {
  chapters: [{ startSeconds: 0, title: "Intro" }],
  creator: "Ada (yt-dlp)",
  creatorId: "UC1",
  creatorUrl: "https://example.test/ada",
  description: "Recorded live.",
  durationSeconds: 999,
  genre: "House",
  releasedAt: "2026-01-01T00:00:00.000Z",
  tags: ["house"],
  thumbnailUrl: "https://example.test/yt.jpg",
  title: "yt-dlp title",
};

const soundCloudWithCreator = () =>
  Promise.resolve(
    Response.json({ author_name: "Ada", title: "Provider title" })
  );

const ytDlpDown = () =>
  Effect.fail(
    new MetadataError({
      message: "yt-dlp could not be run.",
      reason: "provider-unavailable",
    })
  );

const enrichWithYtDlp = (read: YtDlpMetadataService["read"]) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* run() {
        const metadata = yield* Metadata;
        return yield* metadata.enrich({
          source: "soundcloud",
          url: "https://soundcloud.com/a/b",
        });
      }).pipe(
        Effect.provide(
          Metadata.layer({
            fetch: () => Promise.resolve(new Response("{}", { status: 403 })),
            ytDlp: { read },
          })
        )
      )
    )
  );

test("yt-dlp alone enriches a source whose provider is not configured", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* run() {
        const metadata = yield* Metadata;
        return yield* metadata.enrich({
          source: "youtube",
          url: "https://www.youtube.com/watch?v=abc",
        });
      }).pipe(
        Effect.provide(
          Metadata.layer({ ytDlp: { read: () => Effect.succeed(DETAILS) } })
        )
      )
    )
  );
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") {
    expect(result.success.title).toBe("yt-dlp title");
    expect(result.success.durationSeconds).toBe(999);
    expect(result.success.extras?.genre).toBe("House");
  }
});

test("a working provider answers alone, so yt-dlp is not waited on", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* run() {
        const metadata = yield* Metadata;
        return yield* metadata.enrich({
          source: "soundcloud",
          url: "https://soundcloud.com/a/b",
        });
      }).pipe(
        Effect.provide(
          Metadata.layer({
            fetch: soundCloudWithCreator,
            ytDlp: { read: () => Effect.never },
          })
        )
      )
    )
  );
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") {
    expect(result.success.title).toBe("Provider title");
    expect(result.success.extras).toBeUndefined();
  }
});

test("when the provider and yt-dlp both fail, the provider's reason is reported", async () => {
  const both = await enrichWithYtDlp(ytDlpDown);
  expect(both._tag).toBe("Failure");
  if (both._tag === "Failure") {
    expect(both.failure.reason).toBe("provider-rejected");
  }
});

test("stores yt-dlp extras on the Set row but keeps them out of the API response", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-extras-"));
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      details: () => Effect.succeed({ ...DETAILS, creator: "Ignored" }),
      enrich: () => Effect.succeed(PROVIDER_RESULT),
    }),
  });
  try {
    const saved = await saveSet(
      app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.json()).not.toHaveProperty("genre");
    expect(saved.json()).not.toHaveProperty("sourceTags");
    const database = new Database(databasePath, { readonly: true });
    const readRow = () =>
      database
        .query<Record<string, string | null>, []>(
          "SELECT creator, creator_id, details_state, genre, source_tags, source_chapters FROM sets"
        )
        .get();
    const row = await waitFor(() => Boolean(readRow()?.creator_id), readRow);
    database.close();
    expect(row).toEqual({
      creator: "Ada Lovelace",
      creator_id: "UC1",
      details_state: "filled",
      genre: "House",
      source_chapters: '[{"startSeconds":0,"title":"Intro"}]',
      source_tags: '["house"]',
    });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("a save answers without waiting for the details read", async () => {
  const server = await startApp(() => Effect.succeed(PROVIDER_RESULT), {
    details: () => Effect.never,
  });
  try {
    const saved = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.statusCode).toBe(201);
  } finally {
    await server.dispose();
  }
});

const detailsStateAfterSave = async (
  metadata: Parameters<typeof Metadata.layerOf>[0]
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-details-state-"));
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    metadata: Metadata.layerOf(metadata),
  });
  try {
    const saved = await saveSet(
      app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.json()).not.toHaveProperty("detailsState");
    const database = new Database(databasePath, { readonly: true });
    const readRow = () =>
      database
        .query<{ details_state: string }, []>("SELECT details_state FROM sets")
        .get();
    const row = await waitFor(
      () => readRow()?.details_state !== "pending",
      readRow
    );
    database.close();
    return row?.details_state;
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
};

test("details_state becomes failed when the details read fails, and stays pending when yt-dlp is not configured", async () => {
  expect(
    await detailsStateAfterSave({
      details: () => Effect.fail(providerDown()),
      enrich: () => Effect.succeed(PROVIDER_RESULT),
    })
  ).toBe("failed");
  expect(
    await detailsStateAfterSave({
      enrich: () => Effect.succeed(PROVIDER_RESULT),
    })
  ).toBe("pending");
});

test("skips the background details read when enrichment already stored the extras", async () => {
  let reads = 0;
  const state = await detailsStateAfterSave({
    details: () => {
      reads += 1;
      return Effect.succeed(DETAILS);
    },
    enrich: () =>
      Effect.succeed({
        ...PROVIDER_RESULT,
        extras: {
          chapters: [],
          creatorId: null,
          creatorUrl: null,
          description: null,
          genre: "House",
          tags: [],
        },
      }),
  });
  expect(state).toBe("filled");
  expect(reads).toBe(0);
});

test("a Set exposes its creator id and the library filters by it", async () => {
  const server = await startApp(
    (input) =>
      Effect.succeed({
        ...PROVIDER_RESULT,
        extras: {
          chapters: [],
          creatorId: input.url.includes("aaaaaaaaaaa") ? "UC1" : "UC2",
          creatorUrl: null,
          description: null,
          genre: null,
          tags: [],
        },
      }),
    {}
  );
  try {
    await saveSet(server.app, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await saveSet(server.app, "https://www.youtube.com/watch?v=bbbbbbbbbbb");
    const all = await request(server.app, { method: "GET", url: "/sets" });
    expect(
      all
        .json()
        .sets.map((set: { creatorId: string | null }) => set.creatorId)
        .toSorted()
    ).toEqual(["UC1", "UC2"]);
    const filtered = await request(server.app, {
      method: "GET",
      url: "/sets?creatorId=UC1",
    });
    expect(filtered.json().sets).toHaveLength(1);
    expect(filtered.json().sets[0].creatorId).toBe("UC1");
  } finally {
    await server.dispose();
  }
});
