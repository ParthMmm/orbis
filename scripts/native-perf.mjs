#!/usr/bin/env node
// Measures the Library list against a temporary service with a realistic library, so the
// performance gate has a probe that anyone can rerun.
//
// Usage: node scripts/native-perf.mjs [--sets 500] [--samples 20] [--budget-ms 250]

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};

const total = argument("sets", 500);
const sampleCount = argument("samples", 20);
const budget = argument("budget-ms", 250);

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-perf-"));
const port = 48_000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const server = spawn("bun", ["apps/server/src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ORBIS_DATA_DIR: dataDirectory,
    ORBIS_PORT: String(port),
  },
  stdio: "ignore",
});

/// Any HTTP status means the service is listening.
const waitForService = async (deadline = Date.now() + 30_000) => {
  try {
    await fetch(`${base}/health`);
  } catch {
    if (Date.now() > deadline) {
      throw new Error(`the service never answered at ${base}`);
    }
    await sleep(200);
    await waitForService(deadline);
  }
};

const pairDevice = async () => {
  const enrolment = spawn(
    "bun",
    [
      "apps/server/src/trust.ts",
      "add",
      "--label",
      "perf",
      "--devices",
      path.join(dataDirectory, "devices.json"),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] }
  );
  let output = "";
  enrolment.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(enrolment, "exit");
  const token = /shown once: (?<token>\S+)/u.exec(output)?.groups?.token;
  if (!token) {
    throw new Error("the enrolment command printed no token");
  }
  return token;
};

/// Sequential on purpose. The measured quantity is the latency of one request, so issuing
/// them concurrently would measure something else.
const sampleOnce = async (headers, index, samples, record) => {
  if (index >= sampleCount) {
    return;
  }
  const started = performance.now();
  const response = await fetch(`${base}/sets`, { headers });
  const body = await response.json();
  samples.push(performance.now() - started);
  if (index === 0) {
    record(body.sets.length);
  }
  await sampleOnce(headers, index + 1, samples, record);
};

const percentile = (sorted, fraction) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

try {
  await waitForService();
  const headers = {
    authorization: `Bearer ${await pairDevice()}`,
    "content-type": "application/json",
  };

  const seedStarted = performance.now();
  const seeds = Array.from({ length: total }, (_, n) =>
    fetch(`${base}/sets`, {
      body: JSON.stringify({
        tags: [`tag${n % 20}`],
        title: `Set ${n}`,
        url: `https://www.youtube.com/watch?v=${String(n).padStart(11, "a")}`,
      }),
      headers,
      method: "POST",
    })
  );
  await Promise.all(seeds);
  const seededSeconds = (performance.now() - seedStarted) / 1000;

  const samples = [];
  let librarySize = 0;
  await sampleOnce(headers, 0, samples, (size) => {
    librarySize = size;
  });
  console.log(`library size returned: ${librarySize}`);
  samples.sort((a, b) => a - b);

  const median = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  console.log(`seeded ${total} sets in ${seededSeconds.toFixed(1)}s`);
  console.log(
    `GET /sets  median ${median.toFixed(1)} ms   p95 ${p95.toFixed(1)} ms   max ${samples.at(-1).toFixed(1)} ms`
  );
  console.log(`budget ${budget} ms -> ${p95 < budget ? "PASS" : "FAIL"}`);
  process.exitCode = p95 < budget ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  rmSync(dataDirectory, { force: true, recursive: true });
}
