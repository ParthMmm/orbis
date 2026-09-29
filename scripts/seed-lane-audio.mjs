import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

const [dataDirectory, fixture, port] = process.argv.slice(2);
if (!dataDirectory || !fixture || !port) {
  throw new Error("Expected a lane data directory, audio fixture, and port");
}

const db = new Database(path.join(dataDirectory, "library.sqlite"));
const audioDirectory = path.join(dataDirectory, "audio");
const slowSets = new Map();
const downloads = new Map();
const audio = readFileSync(fixture);

const slowAudio = (setId, response) => {
  const completion = Promise.withResolvers();
  downloads.set(setId, completion);
  const aborted = () => completion.resolve();
  response.once("close", aborted);
  const chunks = async function* chunks() {
    try {
      for (let offset = 0; offset < audio.length; offset += 4096) {
        if (offset >= audio.length / 2) {
          // Each attempt holds at partial progress until the journey releases it.
          // oxlint-disable-next-line no-await-in-loop
          await completion.promise;
        }
        // oxlint-disable-next-line no-await-in-loop -- Pace sequential audio chunks.
        await Bun.sleep(250);
        if (response.destroyed) {
          return;
        }
        yield audio.subarray(offset, offset + 4096);
      }
    } finally {
      response.off("close", aborted);
      if (downloads.get(setId) === completion) {
        downloads.delete(setId);
      }
    }
  };
  response.writeHead(200, {
    "content-length": String(audio.length),
    "content-type": "audio/mp4",
  });
  Readable.from(chunks()).pipe(response);
};

const respond = (response, status, body) => {
  response.writeHead(
    status,
    body ? { "content-type": "application/json" } : {}
  );
  response.end(body ? JSON.stringify(body) : undefined);
};

createServer(async (request, response) => {
  const route = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (route === "/health") {
    return respond(response, 204);
  }
  if (request.method === "POST" && route === "/cobalt") {
    const { url } = await new Response(Readable.toWeb(request)).json();
    const setId = slowSets.get(url);
    return setId
      ? respond(response, 200, {
          status: "tunnel",
          url: `http://127.0.0.1:${port}/slow-audio/${setId}`,
        })
      : respond(response, 404);
  }
  const match =
    /^\/(?<action>ready-audio|slow-download|slow-audio|finish-download)\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
      route
    );
  if (!match?.groups) {
    return respond(response, 404);
  }
  const { action, setId } = match.groups;
  const set = db.query("SELECT url FROM sets WHERE id = ?").get(setId);
  if (!set) {
    return respond(response, 404);
  }
  if (request.method === "GET" && action === "slow-audio") {
    return slowSets.get(set.url) === setId
      ? slowAudio(setId, response)
      : respond(response, 404);
  }
  if (request.method !== "POST") {
    return respond(response, 404);
  }
  switch (action) {
    case "slow-download": {
      slowSets.set(set.url, setId);
      break;
    }
    case "finish-download": {
      const download = downloads.get(setId);
      if (!download) {
        return respond(response, 409);
      }
      download.resolve();
      break;
    }
    case "ready-audio": {
      mkdirSync(audioDirectory, { recursive: true });
      copyFileSync(fixture, path.join(audioDirectory, `${setId}.m4a`));
      db.query(
        "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = ?, duration_seconds = 8 WHERE id = ?"
      ).run(statSync(fixture).size, setId);
      break;
    }
    default: {
      return respond(response, 404);
    }
  }
  return respond(response, 204);
}).listen(Number(port), "127.0.0.1");
