import { expect, test } from "bun:test";

import { createApp } from "./app.js";
import { request } from "./test-http.js";

test("saves a SoundCloud short link as the track it redirects to", async () => {
  const asked: string[] = [];
  const app = createApp({
    shortLinkFetch: (url) => {
      asked.push(url);
      return Promise.resolve(
        new Response(null, {
          headers: {
            location:
              "https://soundcloud.com/rinsefm/skin-on-skin-07-august-2026?si=abc&utm_source=clipboard",
          },
          status: 302,
        })
      );
    },
  });
  try {
    const response = await request(app, {
      method: "POST",
      payload: { tags: [], url: "https://on.soundcloud.com/AbCdEf123" },
      url: "/sets",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      source: "soundcloud",
      url: "https://soundcloud.com/rinsefm/skin-on-skin-07-august-2026",
    });
    expect(asked).toEqual(["https://on.soundcloud.com/AbCdEf123"]);
  } finally {
    await app.dispose();
  }
});

test("refuses a short link that does not redirect", async () => {
  const app = createApp({
    shortLinkFetch: () =>
      Promise.resolve(new Response("gone", { status: 404 })),
  });
  try {
    const response = await request(app, {
      method: "POST",
      payload: { tags: [], url: "https://on.soundcloud.com/missing" },
      url: "/sets",
    });
    expect(response.statusCode).toBe(400);
  } finally {
    await app.dispose();
  }
});
