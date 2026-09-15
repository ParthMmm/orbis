import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigProvider, Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";

import { createApp } from "./app.js";
import type { EnrichedMetadata } from "./metadata.js";
import { Metadata } from "./metadata.js";
import { request } from "./test-http.js";
import { TitleReviserError } from "./title-reviser-error.js";
import { TitleReviser } from "./title-reviser.js";

const PROVIDER_RESULT: EnrichedMetadata = {
  artworkUrl: "https://example.test/artwork.jpg",
  creator: "Ada Lovelace",
  durationSeconds: 253,
  title: "Analytical Engine live | SoundCloud",
};

const providerResult = () => Effect.succeed(PROVIDER_RESULT);

// The stub answers generateObject through the text parts, the same path the
// default LanguageModel.make uses when the provider answers with JSON text.
const modelAnswering = (content: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([{ text: content, type: "text" }]),
      streamText: () => Stream.empty,
    })
  );

const modelFailing = () =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.fail(
          AiError.make({
            method: "generateText",
            module: "LanguageModel",
            reason: AiError.reasonFromHttpStatus({ body: {}, status: 502 }),
          })
        ),
      streamText: () => Stream.empty,
    })
  );

const startApp = async (options: {
  enrich?: typeof providerResult;
  reviser?: Layer.Layer<TitleReviser>;
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-title-"));
  const createOptions: Parameters<typeof createApp>[0] = {
    databasePath: path.join(directory, "library.sqlite"),
    metadata: Metadata.layerOf({ enrich: options.enrich ?? providerResult }),
  };
  if (options.reviser) {
    createOptions.titleReviser = options.reviser;
  }
  const app = createApp(createOptions);
  return {
    app,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
  };
};

const saveSet = (app: ReturnType<typeof createApp>, title?: string) =>
  request(app, {
    method: "POST",
    payload:
      title === undefined
        ? { tags: ["mix"], url: "https://www.youtube.com/watch?v=abcdefghijk" }
        : {
            tags: ["mix"],
            title,
            url: "https://www.youtube.com/watch?v=abcdefghijk",
          },
    url: "/sets",
  });

test("stores the revised title when the model answers", async () => {
  const server = await startApp({
    reviser: TitleReviser.layerOf({
      revise: () => Effect.succeed("Ada Lovelace - Analytical Engine"),
    }),
  });
  try {
    const saved = await saveSet(server.app);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "enriched",
      title: "Ada Lovelace - Analytical Engine",
      titleEditedByUser: false,
    });
  } finally {
    await server.dispose();
  }
});

test("keeps the provider title when revision fails", async () => {
  const server = await startApp({
    reviser: TitleReviser.layerOf({
      revise: () =>
        Effect.fail(
          new TitleReviserError({
            message: "The title model did not answer.",
            reason: "model-unavailable",
          })
        ),
    }),
  });
  try {
    const saved = await saveSet(server.app);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "enriched",
      title: "Analytical Engine live | SoundCloud",
    });
  } finally {
    await server.dispose();
  }
});

test("keeps the provider title when revision is not configured", async () => {
  const server = await startApp({});
  try {
    const saved = await saveSet(server.app);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "enriched",
      title: "Analytical Engine live | SoundCloud",
    });
  } finally {
    await server.dispose();
  }
});

test("a typed title is final, so no revision is asked", async () => {
  const server = await startApp({
    reviser: TitleReviser.layerOf({
      revise: () => Effect.succeed("Ada Lovelace - Analytical Engine"),
    }),
  });
  try {
    const saved = await saveSet(server.app, "My own title");
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "pending",
      title: "My own title",
      titleEditedByUser: true,
    });
  } finally {
    await server.dispose();
  }
});

test("the model layer returns the revised title it was given", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      const service = yield* TitleReviser;
      return service;
    }).pipe(
      Effect.provide(
        TitleReviser.layerWithModel(
          modelAnswering('{"title": "Ada Lovelace - Analytical Engine"}')
        )
      )
    )
  );
  const title = await Effect.runPromise(
    reviser.revise({
      creator: "Ada Lovelace",
      source: "youtube",
      title: "Analytical Engine live | SoundCloud",
    })
  );
  expect(title).toBe("Ada Lovelace - Analytical Engine");
});

test("the model layer reports an empty model answer as unexpected", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      return yield* TitleReviser;
    }).pipe(
      Effect.provide(
        TitleReviser.layerWithModel(modelAnswering('{"title": "  "}'))
      )
    )
  );
  const error = await Effect.runPromise(
    reviser
      .revise({
        creator: null,
        source: "youtube",
        title: "Analytical Engine live",
      })
      .pipe(Effect.flip)
  );
  expect(error.reason).toBe("unexpected-response");
});

test("the model layer reports a model failure as unavailable", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      return yield* TitleReviser;
    }).pipe(Effect.provide(TitleReviser.layerWithModel(modelFailing())))
  );
  const error = await Effect.runPromise(
    reviser
      .revise({
        creator: null,
        source: "youtube",
        title: "Analytical Engine live",
      })
      .pipe(Effect.flip)
  );
  expect(error.reason).toBe("model-unavailable");
});

test("layer without a key or model stays unconfigured", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      return yield* TitleReviser;
    }).pipe(
      Effect.provide(TitleReviser.layer({ apiKey: "  ", model: undefined }))
    )
  );
  const error = await Effect.runPromise(
    reviser
      .revise({ creator: null, source: "youtube", title: "Any" })
      .pipe(Effect.flip)
  );
  expect(error.reason).toBe("not-configured");
});

test("the config layer stays unconfigured when the environment is empty", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      return yield* TitleReviser;
    }).pipe(
      Effect.provide(
        TitleReviser.layerConfig().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
        )
      )
    )
  );
  const error = await Effect.runPromise(
    reviser
      .revise({ creator: null, source: "youtube", title: "Any" })
      .pipe(Effect.flip)
  );
  expect(error.reason).toBe("not-configured");
});

test("the config layer needs both the key and the model", async () => {
  const reviser = await Effect.runPromise(
    Effect.gen(function* reviser() {
      return yield* TitleReviser;
    }).pipe(
      Effect.provide(
        TitleReviser.layerConfig().pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ORBIS_OPENROUTER_API_KEY: "test-key",
              })
            )
          )
        )
      )
    )
  );
  const error = await Effect.runPromise(
    reviser
      .revise({ creator: null, source: "youtube", title: "Any" })
      .pipe(Effect.flip)
  );
  expect(error.reason).toBe("not-configured");
});
