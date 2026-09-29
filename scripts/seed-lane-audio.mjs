import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const [dataDirectory, fixture, port] = process.argv.slice(2);
if (!dataDirectory || !fixture || !port) {
  throw new Error("Expected a lane data directory, audio fixture, and port");
}

const db = new Database(path.join(dataDirectory, "library.sqlite"));
const audioDirectory = path.join(dataDirectory, "audio");

Bun.serve({
  fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/health") {
      return new Response(null, { status: 204 });
    }
    const match = /^\/ready-audio\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(route);
    if (request.method !== "POST" || !match?.groups) {
      return new Response(null, { status: 404 });
    }
    const { setId } = match.groups;
    if (!db.query("SELECT id FROM sets WHERE id = ?").get(setId)) {
      return new Response(null, { status: 404 });
    }
    mkdirSync(audioDirectory, { recursive: true });
    copyFileSync(fixture, path.join(audioDirectory, `${setId}.m4a`));
    db.query(
      "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = ?, duration_seconds = 8 WHERE id = ?"
    ).run(statSync(fixture).size, setId);
    return new Response(null, { status: 204 });
  },
  hostname: "127.0.0.1",
  port: Number(port),
});
