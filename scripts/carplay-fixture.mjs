import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const udidFlag = process.argv.indexOf("--udid");
const udid = udidFlag === -1 ? "booted" : process.argv[udidFlag + 1];

const unusedPort = async () => {
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const { port } = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
};

const waitFor = async (url) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Poll until the service answers.
      await fetch(url);
      return;
    } catch {
      // Not listening yet.
    }
    // oxlint-disable-next-line no-await-in-loop -- Poll until the service answers.
    await Bun.sleep(100);
  }
  throw new Error(`${url} did not answer`);
};

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-carplay-"));
const artworkDirectory = path.join(dataDirectory, "artwork");
mkdirSync(artworkDirectory);
const [port, seedPort, artworkPort] = await Promise.all([
  unusedPort(),
  unusedPort(),
  unusedPort(),
]);
const address = `http://127.0.0.1:${port}`;
const seedAddress = `http://127.0.0.1:${seedPort}`;
const token = randomBytes(32).toString("base64url");

const children = [];
const stop = () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}

const fixture = spawn("bun", ["scripts/fixture.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_COBALT_API_KEY: "carplay",
    ORBIS_COBALT_URL: `${seedAddress}/cobalt`,
    ORBIS_FIXTURE_DATA_DIR: dataDirectory,
    ORBIS_FIXTURE_PORT: String(port),
    ORBIS_FIXTURE_TOKEN: token,
    ORBIS_OPENROUTER_API_KEY: "",
    ORBIS_YOUTUBE_API_KEY: "",
    ORBIS_YTDLP_BIN: "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(fixture);
await once(fixture.stdout, "data");
await waitFor(`${address}/health`);

children.push(
  spawn(
    "bun",
    [
      "scripts/seed-lane-audio.mjs",
      dataDirectory,
      path.join(root, "scripts", "fixtures", "ready-set.m4a"),
      String(seedPort),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
  )
);
await waitFor(`${seedAddress}/health`);

const sets = [
  ["Boiler Room Berlin", "Ellen Allien", "#ff5f6d:#ffc371"],
  ["Sunrise at Dekmantel", "Job Jobse", "#2193b0:#6dd5ed"],
  ["Essential Mix", "Four Tet", "#cc2b5e:#753a88"],
  ["Warehouse Project", "Peggy Gou", "#ee9ca7:#ffdde1"],
  ["Lot Radio Session", "Avalon Emerson", "#42275a:#734b6d"],
  ["Panorama Bar Closing", "Prosumer", "#bdc3c7:#2c3e50"],
  ["Rinse FM Takeover", "Shy One", "#de6262:#ffb88c"],
  ["NTS Live", "Call Super", "#06beb6:#48b1bf"],
];

const artworkServer = Bun.serve({
  fetch: (request) =>
    new Response(
      Bun.file(
        path.join(
          artworkDirectory,
          path.basename(new URL(request.url).pathname)
        )
      )
    ),
  hostname: "127.0.0.1",
  port: artworkPort,
});

const api = async (method, route, body) => {
  const response = await fetch(`${address}/${route}`, {
    // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- Every caller writes with POST or PUT.
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} answered ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
};

const seed = async (route) => {
  const response = await fetch(`${seedAddress}/${route}`, { method: "POST" });
  if (response.status !== 204) {
    throw new Error(`seeding ${route} answered ${response.status}`);
  }
};

const db = new Database(path.join(dataDirectory, "library.sqlite"));
const saved = [];
for (const [index, [title, creator, colors]] of sets.entries()) {
  const [from, to] = colors.split(":");
  const image = path.join(artworkDirectory, `${index}.png`);
  const made = spawnSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=600x600:c0=${from}:c1=${to}:x0=0:y0=0:x1=600:y1=600`,
    "-frames:v",
    "1",
    image,
  ]);
  if (made.status !== 0) {
    throw new Error(`ffmpeg could not draw ${image}`);
  }
  // oxlint-disable-next-line no-await-in-loop -- Sets are filed in order, newest last.
  const set = await api("POST", "sets", {
    tags: ["techno"],
    title,
    url: `https://www.youtube.com/watch?v=carplay${String(index).padStart(4, "0")}`,
  });
  db.query("UPDATE sets SET creator = ?, artwork_url = ? WHERE id = ?").run(
    creator,
    `http://127.0.0.1:${artworkPort}/${index}.png`,
    set.id
  );
  saved.push(set);
}

const [downloading, ...playable] = saved;
for (const set of playable) {
  // oxlint-disable-next-line no-await-in-loop -- The seed server copies one file at a time.
  await seed(`ready-audio/${set.id}`);
}
await seed(`tracklist/${playable[0].id}`);

for (const set of playable.slice(0, 3)) {
  // oxlint-disable-next-line no-await-in-loop -- Each Listen starts after the last.
  await api("PUT", "queue/active", { setId: set.id });
  // oxlint-disable-next-line no-await-in-loop -- Each Listen starts after the last.
  await api("PUT", `sets/${set.id}/position`, { seconds: 10 });
}

const late = await api("POST", "playlists", { name: "Late night" });
await api("PUT", `playlists/${late.id}/sets`, {
  setIds: [playable[0].id, playable[2].id, downloading.id, playable[4].id],
});
const warmUp = await api("POST", "playlists", { name: "Warm up" });
await api("PUT", `playlists/${warmUp.id}/sets`, {
  setIds: [playable[1].id, playable[3].id],
});

console.log(
  JSON.stringify(
    {
      address,
      artwork: artworkServer.url.href,
      dataDirectory,
      launch: `xcrun simctl launch ${udid} app.orbis.client -orbisServiceAddress ${address} -orbisSignedInWith ${token}`,
    },
    null,
    2
  )
);
