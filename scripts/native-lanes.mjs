#!/usr/bin/env node
// Drives the native lanes. Starts a temporary Orbis service, pairs a device, generates the
// Xcode project with that service's address and token, runs the tests, and exports the
// screenshots the journeys attached.
//
// Usage:
//   node scripts/native-lanes.mjs --unit        # unit tests only
//   node scripts/native-lanes.mjs --journeys    # UI journeys only
//   node scripts/native-lanes.mjs               # both
//
// Options: --name <simulator name>  --out <screenshot directory>

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const native = path.join(root, "apps", "native");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const unitOnly = process.argv.includes("--unit");
const journeysOnly = process.argv.includes("--journeys");
const simulator = argument("name", "Orbis Lanes");
const shots = path.resolve(
  argument("out", path.join(tmpdir(), "orbis-lane-shots"))
);

const only = [];
if (unitOnly) {
  only.push("-only-testing:OrbisTests");
} else if (journeysOnly) {
  only.push("-only-testing:OrbisUITests");
}

const run = (command, options) => {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf-8",
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command.join(" ")} exited ${result.status}`);
  }
  return result.stdout ?? "";
};

/// Waits for the service to answer. Any HTTP status means it is listening. Written as a
/// bounded retry rather than a polling loop so each attempt is a separate await.
const waitForService = async (address, deadline = Date.now() + 30_000) => {
  try {
    await fetch(`${address}/health`);
  } catch (error) {
    if (Date.now() > deadline) {
      throw new Error(`the lane service never answered at ${address}`, {
        cause: error,
      });
    }
    await sleep(250);
    await waitForService(address, deadline);
  }
};

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-lane-"));
const devicesPath = path.join(dataDirectory, "devices.json");
const port = 43_000 + Math.floor(Math.random() * 2000);
const address = `http://127.0.0.1:${port}`;
const resultBundle = path.join(native, "DerivedData", "result.xcresult");
let server;

const stop = () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
  }
  rmSync(dataDirectory, { force: true, recursive: true });
};
process.on("exit", stop);
process.on("SIGINT", () => {
  process.exit(130);
});

try {
  // A real service on a real port with its own database and trust store, so a lane never
  // touches a developer's library.
  server = spawn("bun", ["apps/server/src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ORBIS_DATA_DIR: dataDirectory,
      ORBIS_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForService(address);
  console.log(`lane service: ${address}`);

  const enrolment = run(
    [
      "bun",
      "apps/server/src/trust.ts",
      "add",
      "--label",
      "lane",
      "--devices",
      devicesPath,
    ],
    { cwd: root }
  );
  const token = /shown once: (?<token>\S+)/u.exec(enrolment)?.groups?.token;
  if (!token) {
    throw new Error("the enrolment command printed no token");
  }

  // Seed one Set through the service's own HTTP path so a journey has something to find.
  const seeded = await fetch(`${address}/sets`, {
    body: JSON.stringify({
      tags: ["techno"],
      title: "Night session",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!seeded.ok) {
    throw new Error(`seeding the lane library failed with ${seeded.status}`);
  }

  run(["xcodegen", "generate"], { cwd: native });

  const derived = path.join(native, "DerivedData");
  rmSync(resultBundle, { force: true, recursive: true });
  run(
    [
      "xcodebuild",
      "-project",
      "Orbis.xcodeproj",
      "-scheme",
      "Orbis",
      "-destination",
      `platform=iOS Simulator,name=${simulator}`,
      "-derivedDataPath",
      derived,
      "-resultBundlePath",
      resultBundle,
      ...only,
      "test",
    ],
    {
      cwd: native,
      // xcodegen substitutes these into the scheme's test action, which is how a journey
      // test receives the address and token it types into the connection screen.
      env: {
        ...process.env,
        ORBIS_UI_TEST_ADDRESS: address,
        ORBIS_UI_TEST_TOKEN: token,
      },
      stdio: "inherit",
    }
  );

  mkdirSync(shots, { recursive: true });
  run(
    [
      "xcrun",
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      resultBundle,
      "--output-path",
      shots,
    ],
    { cwd: native }
  );
  writeFileSync(
    path.join(shots, "lane.txt"),
    `service=${address}\nsimulator=${simulator}\n`
  );
  console.log(`screenshots: ${shots}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stop();
}
