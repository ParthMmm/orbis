import { writeFileSync } from "node:fs";

import { createApp } from "../apps/server/src/app.js";

const app = createApp();
const send = async (path: string, init?: RequestInit) => {
  const response = await app.handler(
    new Request(`http://localhost${path}`, init)
  );
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status}`);
  }
  return response.json();
};
type CaptureRequest =
  | { title: string; url: string }
  | { name: string }
  | { tags: string[] };
const body = (method: string, value: CaptureRequest): RequestInit => ({
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
  method,
});

try {
  const savedSet = await send(
    "/sets",
    body("POST", {
      title: "Contract sample",
      url: "https://youtu.be/abcdefghijk",
    })
  );
  const playlist = await send(
    "/playlists",
    body("POST", { name: "Contract playlist" })
  );
  const taggedSet = await send(
    `/sets/${savedSet.id}/tags`,
    body("PATCH", { tags: ["house"] })
  );
  const samples = {
    audioGrant: { url: `/sets/${savedSet.id}/audio?grant=sample` },
    audioState: await send(`/sets/${savedSet.id}/audio/state`),
    health: await send("/health"),
    library: await send("/sets"),
    me: await send("/me"),
    playlist,
    playlists: await send("/playlists"),
    queue: await send("/queue"),
    savedSet: taggedSet,
    tags: await send("/tags"),
  };
  writeFileSync(
    new URL(
      "../apps/apple/OrbisTests/Fixtures/contract-responses.json",
      import.meta.url
    ),
    `${JSON.stringify(samples, null, 2)}\n`
  );
} finally {
  await app.dispose();
}
