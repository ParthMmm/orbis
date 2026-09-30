import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  AudioStateSchema,
  ListeningQueueSchema,
  PlaylistSchema,
  SavedSetSchema,
  SaveSetResultSchema,
} from "@orbis/contracts/http-api";
import { Ajv } from "ajv";
import { Schema } from "effect";

import { createApp } from "./app.js";

const Samples = Schema.Struct({
  audioGrant: Schema.Struct({ url: Schema.String }),
  audioState: AudioStateSchema,
  health: Schema.Struct({ status: Schema.Literal("ok") }),
  library: Schema.Struct({ sets: Schema.Array(SavedSetSchema) }),
  me: Schema.Struct({
    autoDownload: Schema.Boolean,
    id: Schema.String,
    social: Schema.Boolean,
    username: Schema.String,
  }),
  people: Schema.Struct({
    people: Schema.Array(
      Schema.Struct({ id: Schema.String, username: Schema.String })
    ),
  }),
  playlist: PlaylistSchema,
  playlists: Schema.Struct({ playlists: Schema.Array(PlaylistSchema) }),
  queue: Schema.Struct({ queue: ListeningQueueSchema }),
  saveResult: SaveSetResultSchema,
  savedSet: SavedSetSchema,
  socialFilters: Schema.Struct({ appear: Schema.Boolean, see: Schema.Boolean }),
  tags: Schema.Struct({ tags: Schema.Array(Schema.String) }),
});
const samples = Schema.decodeUnknownSync(Samples)(
  JSON.parse(
    readFileSync(
      new URL(
        "../../apple/OrbisTests/Fixtures/contract-responses.json",
        import.meta.url
      ),
      "utf-8"
    )
  )
);
const OpenApiResponse = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ schema: Schema.Record(Schema.String, Schema.Unknown) })
    )
  ),
});
const OpenApiDocument = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({
        operationId: Schema.String,
        responses: Schema.Record(Schema.String, OpenApiResponse),
      })
    )
  ),
});

const sampleKeyFor = (operationId: string): keyof typeof samples => {
  if (operationId === "sets.save") {
    return "saveResult";
  }
  if (
    operationId === "sets.list" ||
    operationId === "playlists.replaceMembers"
  ) {
    return "library";
  }
  if (operationId === "sets.audioState") {
    return "audioState";
  }
  if (operationId === "sets.audioGrant") {
    return "audioGrant";
  }
  if (operationId === "playlists.list") {
    return "playlists";
  }
  if (
    operationId.startsWith("playlists.") &&
    operationId !== "playlists.replaceSetPlaylists"
  ) {
    return "playlist";
  }
  if (operationId.startsWith("queue.")) {
    return "queue";
  }
  if (operationId === "library.tags") {
    return "tags";
  }
  if (operationId.startsWith("people.")) {
    if (operationId === "people.list") {
      return "people";
    }
    if (operationId === "people.filters") {
      return "socialFilters";
    }
    if (operationId === "people.sets") {
      return "library";
    }
    return "me";
  }
  if (operationId === "system.health") {
    return "health";
  }
  if (
    operationId.startsWith("sets.") ||
    operationId.startsWith("library.") ||
    operationId === "playlists.replaceSetPlaylists"
  ) {
    return "savedSet";
  }
  throw new Error(`No Swift sample for ${operationId}`);
};

const sampleFor = (operationId: string) => {
  if (
    [
      "playlists.collaboration",
      "playlists.setCollaboration",
      "playlists.setEditors",
    ].includes(operationId)
  ) {
    return { collaborative: true, editorIds: ["b"] };
  }
  if (operationId === "people.friendPlaylists") {
    return { playlists: [{ ...samples.playlist, sets: [samples.savedSet] }] };
  }
  if (operationId === "people.friendListens") {
    return {
      listens: [
        {
          finishedAt: null,
          set: samples.savedSet,
          startedAt: "2026-09-29T00:00:00.000Z",
        },
      ],
    };
  }
  // The Swift client has no Devices screen yet, so these samples live here.
  const device = {
    addedAt: "2026-09-29T00:00:00.000Z",
    current: true,
    id: "a1b2c3d4e5f6",
    label: "Laptop",
    lastUsedAt: null,
  };
  if (operationId === "devices.list") {
    return { devices: [device] };
  }
  if (operationId === "devices.revoke") {
    return device;
  }
  return samples[sampleKeyFor(operationId)];
};

test("the served OpenAPI document accepts the Swift response samples", async () => {
  const app = createApp();
  try {
    const response = await app.handler(
      new Request("http://localhost/openapi.json")
    );
    expect(response.status).toBe(200);
    const document = Schema.decodeUnknownSync(OpenApiDocument)(
      await response.json()
    );
    expect(document.openapi).toBe("3.1.0");
    const ajv = new Ajv({ strict: false, validateFormats: false });
    let checked = 0;
    for (const operations of Object.values(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) {
          continue;
        }
        if (operation.operationId.startsWith("admin.")) {
          continue;
        }
        if (operation.operationId === "sets.audio") {
          expect(operation.responses["200"]).toBeDefined();
          expect(operation.responses["206"]).toBeDefined();
          checked += 1;
          continue;
        }
        if (operation.operationId === "events.subscribe") {
          expect(
            operation.responses["200"]?.content?.["text/event-stream"]
          ).toBeDefined();
          checked += 1;
          continue;
        }
        const sample = sampleFor(operation.operationId);
        for (const [status, declared] of Object.entries(operation.responses)) {
          if (Number(status) < 200 || Number(status) >= 300) {
            continue;
          }
          const schema = declared.content?.["application/json"]?.schema;
          expect(schema).toBeDefined();
          if (schema === undefined) {
            throw new Error(
              `${operation.operationId} ${status} has no JSON schema`
            );
          }
          const valid = ajv.compile(schema);
          expect(valid(sample)).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(39);
  } finally {
    await app.dispose();
  }
});
