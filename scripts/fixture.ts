import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createApp } from "../apps/server/src/app.js";
import { startFixtureServer } from "../apps/server/src/fixture-server.js";
import { hashToken } from "../apps/server/src/identity.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const dataDirectory = required("ORBIS_FIXTURE_DATA_DIR");
const token =
  process.env.ORBIS_FIXTURE_TOKEN ?? randomBytes(32).toString("base64url");
const settingsToken =
  process.env.ORBIS_FIXTURE_SETTINGS_TOKEN ??
  randomBytes(32).toString("base64url");
const devicesPath = path.join(dataDirectory, "devices.json");
const databasePath = path.join(dataDirectory, "library.sqlite");
await mkdir(dataDirectory, { recursive: true });
if (await Bun.file(devicesPath).exists()) {
  throw new Error("ORBIS_FIXTURE_DATA_DIR must not contain devices.json.");
}
const addedAt = new Date().toISOString();
await writeFile(
  devicesPath,
  JSON.stringify({
    keys: [
      {
        addedAt,
        id: "fixture-key",
        label: "Fixture",
        lastUsedAt: null,
        personId: "host",
        scope: "admin",
        tokenHash: hashToken(token),
      },
      {
        addedAt,
        id: "fixture-settings-key",
        label: "Fixture settings",
        lastUsedAt: null,
        personId: "fixture-settings",
        scope: "daily",
        tokenHash: hashToken(settingsToken),
      },
    ],
    people: [
      { autoDownload: false, id: "host", removed: false, username: "host" },
      {
        autoDownload: false,
        id: "fixture-settings",
        removed: false,
        username: "lane-settings",
      },
    ],
    version: 2,
  })
);
const audioFile = process.env.ORBIS_FIXTURE_AUDIO_FILE;
const cobaltUrl = audioFile
  ? "http://cobalt.fixture.test/"
  : process.env.ORBIS_COBALT_URL;
const fixtureAudio = audioFile ? Bun.file(audioFile) : undefined;
const app = createApp({
  audio: {
    audioDir: path.join(dataDirectory, "audio"),
    cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
    cobaltUrl,
    fetch: fixtureAudio
      ? async (url) =>
          url.startsWith(cobaltUrl ?? "")
            ? Response.json({
                status: "tunnel",
                url: "http://cdn.fixture.test/ready-set.m4a",
              })
            : new Response(await fixtureAudio.arrayBuffer(), {
                headers: { "content-type": "audio/mp4" },
              })
      : undefined,
    startWorker: true,
    ytdlpBin: process.env.ORBIS_YTDLP_BIN,
    ytdlpCookies: process.env.ORBIS_YTDLP_COOKIES,
  },
  databasePath,
  devicesPath,
  logging: { silent: true },
});
const fixture = await startFixtureServer({
  allowedOrigin: process.env.ORBIS_FIXTURE_ORIGIN,
  app,
  port: Number(process.env.ORBIS_FIXTURE_PORT ?? 0),
  token,
});
process.stdout.write(
  `${JSON.stringify({
    address: fixture.url.toString().replace(/\/$/u, ""),
    settingsToken,
    token,
  })}\n`
);
const close = async () => {
  await fixture.stop();
  if (process.env.ORBIS_FIXTURE_REMOVE_DATA === "true") {
    await rm(dataDirectory, { force: true, recursive: true });
  }
  process.exit(0);
};
process.once("SIGINT", () => close());
process.once("SIGTERM", () => close());
