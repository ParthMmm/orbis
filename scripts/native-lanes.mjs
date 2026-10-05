#!/usr/bin/env node
// Drives the native lanes. Starts a temporary Orbis service, pairs a device, generates the
// Xcode project with that service's address and token, runs the tests, and exports the
// screenshots the journeys attached.
//
// Usage:
//   node scripts/native-lanes.mjs --unit        # unit tests only
//   node scripts/native-lanes.mjs --journeys    # UI journeys on two simulator clones
//   node scripts/native-lanes.mjs               # both
//   node scripts/native-lanes.mjs --unit --macos # unit tests on the macOS host
//
// Options: --name <simulator name>  --udid <simulator UUID>  --out <screenshot directory>
// --macos runs the unit tests on the macOS destination instead of the simulator.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const startedAt = performance.now();
const root = path.resolve(import.meta.dirname, "..");
const native = path.join(root, "apps", "apple");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const unitOnly = process.argv.includes("--unit");
const journeysOnly = process.argv.includes("--journeys");
// A hosted macOS run proves the tests never touch real pairing storage on the machine that
// runs them, which the simulator run cannot show. Journeys stay simulator-only: the UI test
// bundle is iOS-only, so --macos always means the unit tests.
const macos = process.argv.includes("--macos");
const simulator = argument("name", "Orbis Lanes");
const simulatorUdid = argument("udid");
const shots = path.resolve(
  argument("out", path.join(tmpdir(), "orbis-lane-shots"))
);

const only = [];
// --only narrows a lane to one test, which is how a single journey is re-run after a failure
// without running the remaining journeys.
const onlyTest = argument("only");
const parallelJourneys = journeysOnly && !macos && !unitOnly && !onlyTest;
const workerCount = parallelJourneys ? 2 : 1;
if (onlyTest) {
  only.push(`-only-testing:${onlyTest}`);
} else if (macos || unitOnly) {
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

const unusedPort = async (excluded) => {
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const { port } = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port === excluded ? unusedPort(excluded) : port;
};

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-lane-"));
const devicesPath = path.join(dataDirectory, "devices.json");
const port = await unusedPort();
const externalAddress = argument("service-address");
const externalToken = argument("service-token");
if (externalAddress && (!externalToken || !onlyTest)) {
  throw new Error(
    "--service-address requires --service-token and --only for a fixture journey."
  );
}
const address = externalAddress ?? `http://127.0.0.1:${port}`;
const seedPort = await unusedPort(port);
const seedAddress = argument(
  "seed-address",
  externalAddress ?? `http://127.0.0.1:${seedPort}`
);
const resultBundle = path.join(native, "DerivedData", "result.xcresult");
let server;
let seedServer;

const stop = () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
  }
  if (seedServer && seedServer.exitCode === null) {
    seedServer.kill("SIGTERM");
  }
  rmSync(dataDirectory, { force: true, recursive: true });
};
process.on("exit", stop);
process.on("SIGINT", () => {
  process.exit(130);
});

try {
  // A journeys-only run is for UI journeys, so the style gate and the design package are left
  // to the unit run and CI.
  if (!journeysOnly && !onlyTest) {
    // swift-format ships with the Xcode toolchain, so the native style gate needs no install.
    run(["bun", "run", "native:format"], { cwd: root });

    // The design system is a package the app links, so its own rules are verified in the same
    // run as the app's tests rather than by a separate command someone has to remember.
    const design = run(["swift", "test"], {
      cwd: path.join(native, "OrbisDesign"),
    });
    const designSummary = /Test run with [^\n]*passed[^\n]*/u.exec(design);
    console.log(`design package: ${designSummary?.[0] ?? "tests passed"}`);
  }

  let token = externalToken;
  let settingsToken = externalToken;
  if (!externalAddress) {
    server = spawn("bun", ["apps/server/src/index.ts"], {
      cwd: root,
      env: {
        ...process.env,
        ORBIS_COBALT_API_KEY: "lane",
        ORBIS_COBALT_URL: `${seedAddress}/cobalt`,
        ORBIS_DATA_DIR: dataDirectory,
        ORBIS_OPENROUTER_API_KEY: "",
        ORBIS_PORT: String(port),
        ORBIS_YOUTUBE_API_KEY: "",
        ORBIS_YTDLP_BIN: "",
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
    token = /shown once: (?<token>\S+)/u.exec(enrolment)?.groups?.token;
    if (!token) {
      throw new Error("the enrolment command printed no token");
    }

    const preferences = await fetch(`${address}/me`, {
      body: JSON.stringify({ autoDownload: false }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    if (!preferences.ok) {
      throw new Error(
        "could not disable automatic downloads for manual-download journeys"
      );
    }
    const person = run(
      [
        "bun",
        "apps/server/src/trust.ts",
        "person",
        "add",
        "--username",
        "lane-settings",
        "--devices",
        devicesPath,
      ],
      { cwd: root }
    );
    const personId = /Added Person (?<id>\S+)/u.exec(person)?.groups?.id;
    if (!personId) {
      throw new Error("could not create the settings journey Person");
    }
    const settingsEnrolment = run(
      [
        "bun",
        "apps/server/src/trust.ts",
        "key",
        "add",
        "--person",
        personId,
        "--label",
        "settings-journey",
        "--devices",
        devicesPath,
      ],
      { cwd: root }
    );
    settingsToken = /shown once: (?<token>\S+)/u.exec(settingsEnrolment)?.groups
      ?.token;
    if (!settingsToken) {
      throw new Error("could not enrol the settings journey Person");
    }
  }
  if (!token) {
    throw new Error("The lane requires a fixture token.");
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

  if (!externalAddress) {
    seedServer = spawn(
      "bun",
      [
        "scripts/seed-lane-audio.mjs",
        dataDirectory,
        path.join(root, "scripts", "fixtures", "ready-set.m4a"),
        String(seedPort),
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
    );
    await waitForService(seedAddress);
  }

  run(["xcodegen", "generate"], { cwd: native });

  const derived = path.join(native, "DerivedData");
  rmSync(resultBundle, { force: true, recursive: true });
  const testOutput = run(
    [
      "xcodebuild",
      "-project",
      "Orbis.xcodeproj",
      "-scheme",
      "Orbis",
      "-destination",
      macos
        ? "platform=macOS"
        : `platform=iOS Simulator,${simulatorUdid ? `id=${simulatorUdid}` : `name=${simulator}`}`,
      // Ad-hoc signing gives the simulator build the entitlement its keychain needs, while
      // leaving the committed project device-ready. The macOS host cannot ad-hoc sign that
      // entitlement, so the macOS run uses automatic signing with the local development
      // identity from project.yml instead.
      ...(macos ? [] : ["CODE_SIGN_IDENTITY=-"]),
      "-derivedDataPath",
      derived,
      "-resultBundlePath",
      resultBundle,
      ...only,
      ...(parallelJourneys
        ? [
            "-parallel-testing-enabled",
            "YES",
            "-parallel-testing-worker-count",
            String(workerCount),
          ]
        : []),
      "test",
    ],
    {
      cwd: native,
      // xcodegen substitutes these into the scheme's test action, which is how a journey
      // test receives the address and token it types into the connection screen.
      env: {
        ...process.env,
        ORBIS_UI_TEST_ADDRESS: address,
        ORBIS_UI_TEST_SEED_ADDRESS: seedAddress,
        ORBIS_UI_TEST_SETTINGS_TOKEN: settingsToken,
        ORBIS_UI_TEST_TOKEN: token,
      },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  process.stdout.write(testOutput);

  const testWorkers = new Map();
  for (const match of testOutput.matchAll(
    /^Test suite '(?<suite>[^']+)' started on '(?<worker>Clone (?<number>\d+) of .+?) - .+'$/gmu
  )) {
    testWorkers.set(match.groups.suite, {
      directory: `worker-${match.groups.number}`,
      name: match.groups.worker,
    });
  }

  // The export refuses to write into a directory that already holds a manifest, so a second
  // run would fail after the tests passed.
  rmSync(shots, { force: true, recursive: true });
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, "xcodebuild.log"), testOutput);
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
  const manifest = JSON.parse(
    readFileSync(path.join(shots, "manifest.json"), "utf-8")
  );
  const workers = new Map();
  for (const test of manifest) {
    for (const attachment of test.attachments) {
      const assignment = testWorkers.get(test.testIdentifier.split("/")[0]);
      if (parallelJourneys && !assignment) {
        throw new Error(`no simulator worker found for ${test.testIdentifier}`);
      }
      const worker = assignment ?? {
        directory: "worker-1",
        name: attachment.deviceName,
      };
      workers.set(worker.name, worker);
      const named = attachment.suggestedHumanReadableName.replace(
        /_(?<iteration>\d+)_[0-9A-F-]{36}(?=\.\w+$)/u,
        (_suffix, iteration) => (iteration === "0" ? "" : `-${iteration}`)
      );
      const directory = parallelJourneys
        ? path.join(
            worker.directory,
            test.testIdentifier
              .replaceAll(/[^a-zA-Z0-9_-]+/gu, "-")
              .replace(/-$/u, "")
          )
        : ".";
      mkdirSync(path.join(shots, directory), { recursive: true });
      const exported = path.join(directory, named);
      renameSync(
        path.join(shots, attachment.exportedFileName),
        path.join(shots, exported)
      );
      attachment.exportedFileName = exported;
    }
  }
  writeFileSync(
    path.join(shots, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const elapsedSeconds = Number(
    ((performance.now() - startedAt) / 1000).toFixed(3)
  );
  writeFileSync(
    path.join(shots, "lane.json"),
    `${JSON.stringify(
      {
        elapsedSeconds,
        requestedWorkers: workerCount,
        simulator,
        simulatorUdid,
        workers: [...workers.values()],
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(shots, "lane.txt"),
    `service=${address}\nsimulator=${simulator}\n`
  );
  console.log(`screenshots: ${shots}`);
  console.log(`lane completed in ${elapsedSeconds}s`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stop();
}
