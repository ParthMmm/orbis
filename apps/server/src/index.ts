import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createApp } from "./app.js";
import { Metadata } from "./metadata.js";

const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
await mkdir(dataDirectory, { recursive: true });
const databasePath = path.join(dataDirectory, "library.sqlite");
const youTubeApiKey = process.env.ORBIS_YOUTUBE_API_KEY;
const app = createApp({
  databasePath,
  logging: { environment: process.env.NODE_ENV ?? "development" },
  metadata: Metadata.layer({
    youTubeApiKey,
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
console.log(`Orbis API listening on ${server.url}`);
console.log(`Library database: ${databasePath}`);
if (!youTubeApiKey) {
  console.warn(
    "ORBIS_YOUTUBE_API_KEY is not set, so YouTube metadata enrichment is unavailable."
  );
}
let stopping = false;
const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await server.stop();
    await app.dispose();
    console.log("Orbis API stopped.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
