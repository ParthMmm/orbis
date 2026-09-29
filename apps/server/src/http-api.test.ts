import { expect, test } from "bun:test";

import { AudioStateSchema, SavedSetSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createApp } from "./app.js";

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
