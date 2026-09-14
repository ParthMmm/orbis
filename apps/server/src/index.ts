import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createApp } from "./app.js";
import { listenerPorts, startListeners } from "./listeners.js";
import { Metadata } from "./metadata.js";

const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
await mkdir(dataDirectory, { recursive: true });
const databasePath = path.join(dataDirectory, "library.sqlite");
const youTubeApiKey = process.env.ORBIS_YOUTUBE_API_KEY;
const ports = listenerPorts({
  ORBIS_DEVICE_PORT: process.env.ORBIS_DEVICE_PORT,
  ORBIS_PORT: process.env.ORBIS_PORT,
});
const app = createApp({
  audio: {
    audioDir: path.join(dataDirectory, "audio"),
    cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
    cobaltUrl: process.env.ORBIS_COBALT_URL,
    startWorker: true,
  },
  databasePath,
  logging: { environment: process.env.NODE_ENV ?? "development" },
  metadata: Metadata.layer({ youTubeApiKey }),
});
const listeners = await startListeners(app, ports);
console.log(`Orbis local API listening on ${listeners.local.url}`);
if (listeners.device) {
  console.log(`Orbis device API listening on ${listeners.device.url}`);
}
console.log(`Library database: ${databasePath}`);
if (!process.env.ORBIS_COBALT_URL || !process.env.ORBIS_COBALT_API_KEY) {
  console.warn(
    "ORBIS_COBALT_URL or ORBIS_COBALT_API_KEY is not set, so audio downloads are unavailable."
  );
}
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
    await listeners.stop();
    console.log("Orbis API stopped.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
