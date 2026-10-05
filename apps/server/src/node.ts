import { readFileSync } from "node:fs";

import { startAudioNode } from "./audio-node.js";
import { configureLogging } from "./logging.js";
import { makeNodeHttpHandler } from "./node-http.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};
const url = new URL(required("ORBIS_GROUP_URL"));
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.pathname = `${url.pathname.replace(/\/$/u, "")}/node`;
const audioDir = required("ORBIS_AUDIO_DIR");
const streamSecret = readFileSync(required("ORBIS_STREAM_SECRET_FILE"));
if (streamSecret.length !== 32) {
  throw new Error("Invalid stream grant secret");
}
configureLogging({ environment: process.env.NODE_ENV ?? "development" });
const audio = Bun.serve({
  fetch: makeNodeHttpHandler({
    apiUrl: new URL(required("ORBIS_API_FORWARD_URL")),
    audioDir,
    streamSecret,
  }),
  hostname: process.env.ORBIS_NODE_HOST ?? "127.0.0.1",
  port: Number(process.env.ORBIS_NODE_PORT ?? "4311"),
});
const node = await startAudioNode({
  audioDir,
  cobaltApiKey: process.env.ORBIS_COBALT_API_KEY,
  cobaltUrl: process.env.ORBIS_COBALT_URL,
  groupUrl: url.toString(),
  nodeKey: required("ORBIS_NODE_KEY"),
  ytdlpBin: process.env.ORBIS_YTDLP_BIN,
  ytdlpCookies: process.env.ORBIS_YTDLP_COOKIES,
});
const close = async () => {
  await node.close();
  await audio.stop(true);
  process.exit(0);
};
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
