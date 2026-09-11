import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createApp } from "./app.js";
import { Metadata } from "./metadata.js";

const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
await mkdir(dataDirectory, { recursive: true });
const app = createApp({
  databasePath: path.join(dataDirectory, "library.sqlite"),
  metadata: Metadata.layer({
    youTubeApiKey: process.env.ORBIS_YOUTUBE_API_KEY,
  }),
});
const port = Number(process.env.ORBIS_PORT ?? 4310);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("ORBIS_PORT must be an integer between 0 and 65535.");
}
const server = Bun.serve({
  fetch: (request) => app.handler(request),
  hostname: "127.0.0.1",
  maxRequestBodySize: 65_536,
  port,
});
console.log(`Orbis API: ${server.url}`);
let stopping = false;
const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await server.stop();
    await app.dispose();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
