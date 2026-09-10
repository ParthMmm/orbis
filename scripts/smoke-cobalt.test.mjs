import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const smokeScript = path.join(root, "scripts/smoke-cobalt.mjs");
const apiKey = "11111111-1111-4111-8111-111111111111";
const audio = Buffer.alloc(2 * 1024 * 1024);

const startFakeCobalt = async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });

    if (request.method === "GET" && request.url === "/") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          cobalt: {
            services: ["youtube", "soundcloud"],
            url: `http://127.0.0.1:${server.address().port}/`,
            version: "11",
          },
        })
      );
      return;
    }

    if (request.method === "POST" && request.url === "/") {
      if (request.headers.authorization !== `Api-Key ${apiKey}`) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "error.api.auth.key.invalid" },
            status: "error",
          })
        );
        return;
      }

      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const payload = JSON.parse(body);
      response.setHeader("content-type", "application/json");

      if (payload.url.startsWith("https://example.invalid/")) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error: { code: "error.api.link.invalid" },
            status: "error",
          })
        );
        return;
      }

      response.end(
        JSON.stringify({
          filename: "../../not-used.mp3",
          status: "tunnel",
          url: `http://127.0.0.1:${server.address().port}/tunnel?id=${requests.length}`,
        })
      );
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/tunnel?")) {
      response.setHeader("content-type", "audio/wav");
      response.end(audio);
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    async close() {
      server.close();
      await once(server, "close");
    },
    endpoint: `http://127.0.0.1:${server.address().port}/`,
    requests,
  };
};

const writeFakeFfprobe = async (directory, ffmpegExitCode = 0) => {
  const command = path.join(directory, "ffprobe");
  await writeFile(
    command,
    `#!/usr/bin/env node
const file = process.argv.at(-1);
const duration = file.includes("1-youtube") || file.includes("2-soundcloud") ? "1" : "10801";
process.stdout.write(JSON.stringify({
  format: { duration, format_name: "wav" },
  streams: [{ codec_name: "pcm_s16le", codec_type: "audio" }],
}));
`
  );
  await chmod(command, 0o755);
  const decoder = path.join(directory, "ffmpeg");
  await writeFile(
    decoder,
    `#!/usr/bin/env node
process.exitCode = ${ffmpegExitCode};
`
  );
  await chmod(decoder, 0o755);
  return command;
};

const runSmoke = (args, environment) =>
  // A child process does not expose a promise-based close event.
  // eslint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript, ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stderr, stdout })
    );
  });

const smokeArgs = (endpoint, report, ffprobe, extra = []) => [
  "--endpoint",
  endpoint,
  "--api-key-env",
  "COBALT_TEST_API_KEY",
  "--invalid-url",
  "https://example.invalid/not-supported",
  "--sample",
  "youtube|https://youtu.be/test-video|1",
  "--sample",
  "soundcloud|https://soundcloud.com/artist/track|1",
  "--sample",
  "youtube|https://youtu.be/long-set|10801",
  "--report",
  report,
  "--ffprobe-bin",
  ffprobe,
  "--ffmpeg-bin",
  path.join(path.dirname(ffprobe), "ffmpeg"),
  "--interrupt-after-bytes",
  "1048576",
  ...extra,
];

test("smoke command checks auth, source downloads, cancellation, and cleanup", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "orbis-cobalt-test-"));
  const tempRoot = path.join(workspace, "temporary");
  const report = path.join(workspace, "report.json");
  await mkdir(tempRoot);
  const ffprobe = await writeFakeFfprobe(workspace);
  const cobalt = await startFakeCobalt();

  try {
    const result = await runSmoke(smokeArgs(cobalt.endpoint, report, ffprobe), {
      COBALT_TEST_API_KEY: apiKey,
      TMPDIR: tempRoot,
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, new RegExp(apiKey, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(apiKey, "u"));

    const reportContents = await readFile(report, "utf-8");
    const evidence = JSON.parse(reportContents);
    assert.doesNotMatch(reportContents, new RegExp(apiKey, "u"));
    assert.equal(evidence.overall, "passed");
    assert.equal(evidence.checks.missingApiKey.status, "passed");
    assert.equal(evidence.checks.invalidApiKey.status, "passed");
    assert.equal(evidence.checks.invalidSource.status, "passed");
    assert.equal(evidence.interruption.status, "passed");
    assert.deepEqual(
      evidence.samples.map((sample) => sample.status),
      ["passed", "passed", "passed"]
    );
    assert.deepEqual(await readdir(tempRoot), []);

    const protectedRequests = cobalt.requests.filter(
      (request) => request.method === "POST" && request.authorization
    );
    assert.ok(protectedRequests.length >= 4);
  } finally {
    await cobalt.close();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("smoke command reports bounded downloads as failures and removes partial files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "orbis-cobalt-test-"));
  const tempRoot = path.join(workspace, "temporary");
  const report = path.join(workspace, "report.json");
  await mkdir(tempRoot);
  const ffprobe = await writeFakeFfprobe(workspace);
  const cobalt = await startFakeCobalt();

  try {
    const result = await runSmoke(
      smokeArgs(cobalt.endpoint, report, ffprobe, ["--max-bytes", "1024"]),
      {
        COBALT_TEST_API_KEY: apiKey,
        TMPDIR: tempRoot,
      }
    );
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

    const evidence = JSON.parse(await readFile(report, "utf-8"));
    assert.equal(evidence.overall, "failed");
    assert.equal(evidence.samples[0].status, "failed");
    assert.equal(evidence.samples[0].reason, "max_size_exceeded");
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await cobalt.close();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("smoke command rejects media that cannot be decoded completely", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "orbis-cobalt-test-"));
  const tempRoot = path.join(workspace, "temporary");
  const report = path.join(workspace, "report.json");
  await mkdir(tempRoot);
  const ffprobe = await writeFakeFfprobe(workspace, 1);
  const cobalt = await startFakeCobalt();

  try {
    const result = await runSmoke(smokeArgs(cobalt.endpoint, report, ffprobe), {
      COBALT_TEST_API_KEY: apiKey,
      TMPDIR: tempRoot,
    });
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

    const evidence = JSON.parse(await readFile(report, "utf-8"));
    assert.equal(evidence.overall, "failed");
    assert.equal(evidence.samples[0].reason, "audio_decode_failed");
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await cobalt.close();
    await rm(workspace, { force: true, recursive: true });
  }
});
