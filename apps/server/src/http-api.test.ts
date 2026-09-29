import { expect, test } from "bun:test";

import {
  AudioStateSchema,
  ListeningQueueSchema,
  PlaylistSchema,
  SavedSetSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createApp } from "./app.js";
import { ready, withSeededApp } from "./test-library.js";

type PlaylistRequestBody =
  | { name: string }
  | { setIds: string[] }
  | { playlistIds: string[] }
  | { title: string; url: string }
  | { placement: "next" | "end"; setId: string }
  | { playlistId: string }
  | { seconds: number }
  | { setId: string }
  | { tags: string[] };

const json = (method: string, body: PlaylistRequestBody): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  method,
});

test("the Sets contract decodes live HTTP responses", async () => {
  const app = createApp();
  const send = (path: string, init?: RequestInit) =>
    app.handler(new Request(`http://localhost${path}`, init));

  try {
    const savedResponse = await send("/sets", {
      body: JSON.stringify({
        tags: ["house"],
        title: "Contract set",
        url: "https://youtu.be/abcdefghijk",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(savedResponse.status).toBe(201);
    const saved = Schema.decodeUnknownSync(SavedSetSchema)(
      await savedResponse.json()
    );

    const listedResponse = await send("/sets?tag=house");
    expect(listedResponse.status).toBe(200);
    const listed = Schema.decodeUnknownSync(
      Schema.Struct({ sets: Schema.Array(SavedSetSchema) })
    )(await listedResponse.json());
    expect(listed.sets.map((set) => set.id)).toEqual([saved.id]);

    const repeatedFilters = await send(
      "/sets?q=Contract&q=missing&source=youtube&source=soundcloud"
    );
    expect(repeatedFilters.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ sets: Schema.Array(SavedSetSchema) })
      )(await repeatedFilters.json()).sets.map((set) => set.id)
    ).toEqual([saved.id]);

    const titleResponse = await send(`/sets/${saved.id}/title`, {
      body: JSON.stringify({ title: "Renamed set" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(titleResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SavedSetSchema)(await titleResponse.json()).title
    ).toBe("Renamed set");

    const stateResponse = await send(`/sets/${saved.id}/audio/state`);
    expect(stateResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(AudioStateSchema)(await stateResponse.json())
        .state
    ).toBe("none");

    const removedResponse = await send(`/sets/${saved.id}`, {
      method: "DELETE",
    });
    expect(removedResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SavedSetSchema)(await removedResponse.json()).id
    ).toBe(saved.id);
  } finally {
    await app.dispose();
  }
});

test("the Playlist contract decodes live HTTP responses", async () => {
  const app = createApp();
  const send = (path: string, init?: RequestInit) =>
    app.handler(new Request(`http://localhost${path}`, init));
  try {
    const setResponse = await send(
      "/sets",
      json("POST", {
        title: "Playlist set",
        url: "https://youtu.be/abcdefghijk",
      })
    );
    const set = Schema.decodeUnknownSync(SavedSetSchema)(
      await setResponse.json()
    );

    const createdResponse = await send(
      "/playlists",
      json("POST", { name: "First" })
    );
    expect(createdResponse.status).toBe(201);
    const playlist = Schema.decodeUnknownSync(PlaylistSchema)(
      await createdResponse.json()
    );

    const listedResponse = await send("/playlists");
    expect(listedResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ playlists: Schema.Array(PlaylistSchema) })
      )(await listedResponse.json()).playlists.map((item) => item.id)
    ).toEqual([playlist.id]);

    const membersResponse = await send(
      `/playlists/${playlist.id}/sets`,
      json("PUT", { setIds: [set.id] })
    );
    expect(membersResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ sets: Schema.Array(SavedSetSchema) })
      )(await membersResponse.json()).sets.map((item) => item.id)
    ).toEqual([set.id]);

    const membershipResponse = await send(
      `/sets/${set.id}/playlists`,
      json("PUT", { playlistIds: [playlist.id] })
    );
    expect(membershipResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SavedSetSchema)(await membershipResponse.json())
        .playlistIds
    ).toEqual([playlist.id]);

    const renamedResponse = await send(
      `/playlists/${playlist.id}`,
      json("PATCH", { name: "Renamed" })
    );
    expect(renamedResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(PlaylistSchema)(await renamedResponse.json())
        .name
    ).toBe("Renamed");

    const removedResponse = await send(`/playlists/${playlist.id}`, {
      method: "DELETE",
    });
    expect(removedResponse.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(PlaylistSchema)(await removedResponse.json()).id
    ).toBe(playlist.id);
  } finally {
    await app.dispose();
  }
});

test("the queue, position, and Tag contract decodes live HTTP responses", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    const send = (path: string, init?: RequestInit) =>
      app.handler(new Request(`http://localhost${path}`, init));
    const queue = async (path: string, init?: RequestInit) => {
      const response = await send(path, init);
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ queue: ListeningQueueSchema })
      )(await response.json());
      return { body, status: response.status };
    };

    const initial = await queue("/queue");
    expect(initial.body.queue.entries).toEqual([]);
    const active = await queue("/queue/active", json("PUT", { setId: "a" }));
    expect(active.body.queue.activeSetId).toBe("a");
    const inserted = await queue(
      "/queue/entries",
      json("POST", { placement: "end", setId: "b" })
    );
    expect(inserted.status).toBe(201);
    expect(inserted.body.queue.entries.map((set) => set.id)).toEqual([
      "a",
      "b",
    ]);
    const completed = await queue(
      "/queue/completion",
      json("POST", { setId: "a" })
    );
    expect(completed.body.queue.activeSetId).toBe("b");

    const position = await send(
      "/sets/b/position",
      json("PUT", { seconds: 30 })
    );
    expect(position.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SavedSetSchema)(await position.json())
        .playbackPositionSeconds
    ).toBe(30);
    const tagged = await send(
      "/sets/b/tags",
      json("PATCH", { tags: ["house"] })
    );
    expect(tagged.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(SavedSetSchema)(await tagged.json()).tags
    ).toEqual(["house"]);
    const tags = await send("/tags");
    expect(tags.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ tags: Schema.Array(Schema.String) })
      )(await tags.json()).tags
    ).toEqual(["house"]);
    const health = await send("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });
});
