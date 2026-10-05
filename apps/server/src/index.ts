import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createApp } from "./app.js";
import { cutoverHandler, cutoverMode } from "./cutover.js";
import { hashToken, readTrustRegistry } from "./identity.js";
import { listenerPorts, startListeners } from "./listeners.js";
import { Metadata } from "./metadata.js";
import { TitleReviser } from "./title-reviser.js";
import { Versos } from "./versos.js";
import { ytDlpMetadata } from "./ytdlp-metadata.js";

const dataDirectory = path.resolve(process.env.ORBIS_DATA_DIR ?? "data");
await mkdir(dataDirectory, { recursive: true });
const databasePath = path.join(dataDirectory, "library.sqlite");
const mode = cutoverMode({
  ORBIS_API_FORWARD_URL: process.env.ORBIS_API_FORWARD_URL,
  ORBIS_READ_ONLY: process.env.ORBIS_READ_ONLY,
});
const youTubeApiKey = process.env.ORBIS_YOUTUBE_API_KEY;
const ytDlpBin = process.env.ORBIS_YTDLP_BIN;
if (ytDlpBin && !path.isAbsolute(ytDlpBin)) {
  throw new Error("ORBIS_YTDLP_BIN must be an absolute path.");
}
const ytDlp = ytDlpBin ? ytDlpMetadata({ binPath: ytDlpBin }) : undefined;
const ports = listenerPorts({
  ORBIS_DEVICE_PORT: process.env.ORBIS_DEVICE_PORT,
  ORBIS_PORT: process.env.ORBIS_PORT,
});
const app = createApp({
  allowDevelopmentOrigins: process.env.NODE_ENV === "development",
  audio: {
    audioDir: path.join(dataDirectory, "audio"),
    cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
    cobaltUrl: process.env.ORBIS_COBALT_URL,
    recoverInterruptedDownloads: mode.kind === "serve",
    startWorker: mode.kind === "serve",
    ytdlpBin: process.env.ORBIS_YTDLP_BIN,
    ytdlpCookies: process.env.ORBIS_YTDLP_COOKIES,
  },
  databasePath,
  logging: { environment: process.env.NODE_ENV ?? "development" },
  metadata: Metadata.layer({ youTubeApiKey, ytDlp }),
  recordKeyUse: mode.kind === "serve",
  titleReviser: TitleReviser.layerConfig(),
  versos: Versos.layerConfig(),
});
const listeners = await startListeners(
  {
    dispose: app.dispose,
    handler: cutoverHandler(app.handler, mode, {
      keyLabel: (request) => {
        const authorization = request.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return null;
        }
        const digest = hashToken(authorization.slice(7));
        const registry = readTrustRegistry(
          path.join(dataDirectory, "devices.json")
        );
        return (
          registry.store.keys.find((key) => key.tokenHash === digest)?.label ??
          null
        );
      },
    }),
  },
  ports
);
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
if (!(youTubeApiKey || ytDlp)) {
  console.warn(
    "Neither ORBIS_YOUTUBE_API_KEY nor ORBIS_YTDLP_BIN is set, so YouTube metadata enrichment is unavailable."
  );
}
if (!ytDlp) {
  console.warn(
    "ORBIS_YTDLP_BIN is not set, so Sets keep no genre, description, source tags, or chapters."
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
