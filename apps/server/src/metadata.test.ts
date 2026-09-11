import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SetSource } from "@orbis/contracts";
import { Effect } from "effect";

import { createApp } from "./app.js";
import { MetadataError } from "./metadata-error.js";
import type { EnrichedMetadata, MetadataOptions } from "./metadata.js";
import { Metadata } from "./metadata.js";
import { request } from "./test-http.js";

const PROVIDER_RESULT: EnrichedMetadata = {
  artworkUrl: "https://example.test/artwork.jpg",
  creator: "Ada Lovelace",
  durationSeconds: 253,
  title: "Analytical Engine live",
};

const providerDown = () =>
  new MetadataError({
    message: "The provider is unreachable.",
    reason: "provider-unavailable",
  });

interface EnrichInput {
  readonly source: SetSource;
  readonly url: string;
}

type Enrich = (
  input: EnrichInput
) => Effect.Effect<EnrichedMetadata, MetadataError>;

const startApp = async (enrich: Enrich) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-metadata-"));
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    metadata: Metadata.layerOf({ enrich }),
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
      artworkUrl: "https://example.test/artwork.jpg",
      createdAt: expect.any(String),
      creator: "Ada Lovelace",
      downloadState: "none",
      durationSeconds: 253,
      finishCount: 0,
      id: expect.any(String),
      lastListenedAt: null,
      listenCount: 0,
      metadataState: "enriched",
      playbackPositionSeconds: 0,
      retainedAudioBytes: null,
      retainedAudioFormat: null,
      source: "youtube",
      tags: ["mix"],
      title: "Analytical Engine live",
      titleEditedByUser: false,
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

test("saves the Set with a temporary title when the provider fails", async () => {
  const server = await startApp(() => Effect.fail(providerDown()));
  try {
    const saved = await saveSet(
      server.app,
      "https://www.youtube.com/watch?v=abcdefghijk"
    );
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "failed",
      title: "YouTube video",
      titleEditedByUser: false,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
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
      artworkUrl: null,
      creator: null,
      durationSeconds: null,
      metadataState: "failed",
      source: "soundcloud",
      title: "SoundCloud track",
    });

    const library = await request(server.app, { method: "GET", url: "/sets" });
    expect(library.json()).toEqual({ sets: [saved.json()] });
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
      ...saved.json(),
      artworkUrl: "https://example.test/artwork.jpg",
      creator: "Ada Lovelace",
      durationSeconds: 253,
      metadataState: "enriched",
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
      artworkUrl: "https://example.test/artwork.jpg",
      creator: "Ada Lovelace",
      durationSeconds: 253,
      metadataState: "enriched",
    });
  } finally {
    await server.dispose();
  }
});

test("retry reports a missing set and a second failure without losing the Set", async () => {
  const server = await startApp(() => Effect.fail(providerDown()));
  try {
    const saved = await saveSet(
      server.app,
      "https://soundcloud.com/artist/track"
    );
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${String(saved.json().id)}/metadata`,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(saved.json());

    const missing = await request(server.app, {
      method: "POST",
      url: "/sets/missing/metadata",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe("Set not found.");
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
    expect(byCreator.json().sets).toEqual([youtube.json()]);
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
  medium?: { url: string };
}

const youTubeBody = (thumbnails: Thumbnails) => ({
  items: [
    {
      contentDetails: { duration: "PT4M13S" },
      snippet: {
        channelTitle: "Ada Lovelace",
        thumbnails,
        title: "Analytical Engine live",
      },
    },
  ],
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
    artworkUrl: "https://example.test/default.jpg",
    creator: "Ada Lovelace",
    durationSeconds: 253,
    title: "Analytical Engine live",
  });
  expect(requested).toEqual([
    "https://www.googleapis.com/youtube/v3/videos?id=abcdefghijk&key=test-key&part=snippet%2CcontentDetails",
  ]);
});

test("prefers the high YouTube thumbnail, then medium, then default", async () => {
  const artworkOf = async (thumbnails: Thumbnails) => {
    const metadata = await enrichWith(
      {
        fetch: respondWith(youTubeBody(thumbnails)),
        youTubeApiKey: "test-key",
      },
      { source: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" }
    );
    return metadata.artworkUrl;
  };

  expect(
    await artworkOf({
      default: { url: "https://example.test/default.jpg" },
      high: { url: "https://example.test/high.jpg" },
      medium: { url: "https://example.test/medium.jpg" },
    })
  ).toBe("https://example.test/high.jpg");
  expect(
    await artworkOf({
      default: { url: "https://example.test/default.jpg" },
      medium: { url: "https://example.test/medium.jpg" },
    })
  ).toBe("https://example.test/medium.jpg");
  expect(await artworkOf({})).toBeNull();
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
    artworkUrl: "https://example.test/hopper.jpg",
    creator: "Grace Hopper",
    durationSeconds: null,
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
