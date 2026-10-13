#!/usr/bin/env node
// Drives the native lanes. Starts a temporary Orbis service, pairs a device, generates the
// Xcode project with that service's address and token, runs the tests, and exports the
// screenshots the journeys attached.
//
// Usage:
//   node scripts/native-lanes.mjs --unit        # unit tests only
//   node scripts/native-lanes.mjs --journeys    # UI journeys on two simulators at once
//   node scripts/native-lanes.mjs               # both
//   node scripts/native-lanes.mjs --unit --macos # unit tests on the macOS host
//
// Options: --name <simulator name>  --udid <simulator UUID>  --out <screenshot directory>
// --macos runs the unit tests on the macOS destination instead of the simulator.

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

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

/// The asynchronous `run`, for the commands a parallel lane runs at the same time. Resolves with
/// the output whatever the exit status, because a failed shard still has a result bundle and a
/// log the run must keep.
const execFileAsync = promisify(execFile);
const runConcurrently = async (command, options) => {
  try {
    const { stderr, stdout } = await execFileAsync(
      command[0],
      command.slice(1),
      {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      }
    );
    return { status: 0, stderr, stdout };
  } catch (error) {
    return {
      status: Number.isInteger(error.code) ? error.code : 1,
      stderr: error.stderr ?? String(error),
      stdout: error.stdout ?? "",
    };
  }
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

const resultBundle = path.join(native, "DerivedData", "result.xcresult");

const secondsSince = (since) =>
  Number(((performance.now() - since) / 1000).toFixed(3));

/// Every journey, one entry per test method, read from the UI test sources. Each test class is
/// final and alone in its file; the base classes the classes extend hold no tests.
const journeys = () => {
  const directory = path.join(native, "OrbisUITests");
  const found = [];
  for (const file of readdirSync(directory).toSorted()) {
    if (!file.endsWith(".swift")) {
      continue;
    }
    const source = readFileSync(path.join(directory, file), "utf-8");
    const tests = [...source.matchAll(/^\s*func (?<name>test\w+)\(\)/gmu)];
    if (tests.length === 0) {
      continue;
    }
    const suite = /^final class (?<name>\w+)\s*:/mu.exec(source)?.groups.name;
    if (!suite) {
      throw new Error(`${file} holds journeys but no final test class`);
    }
    for (const test of tests) {
      found.push({ id: `${suite}/${test.groups.name}`, suite });
    }
  }
  return found;
};

// Each journey's last measured duration, so the next run can split the work evenly. It lives
// beside the build, which is untracked, because the numbers belong to this machine.
const timingsFile = path.join(native, "DerivedData", "journey-timings.json");
const readTimings = () => {
  if (!existsSync(timingsFile)) {
    return {};
  }
  return JSON.parse(readFileSync(timingsFile, "utf-8"));
};

/// Splits the journeys into `count` shards of about equal expected time: the longest class
/// first, each to the shard with the least work so far. A class stays on one simulator, as it
/// does under Xcode's parallel testing, because journeys in one class may share service state
/// (one deletes every playlist). A journey never measured counts as the average.
const shardJourneys = (tests, timings, count) => {
  const known = Object.values(timings);
  let fallback = 30;
  if (known.length > 0) {
    let total = 0;
    for (const value of known) {
      total += value;
    }
    fallback = total / known.length;
  }
  const classes = new Map();
  for (const test of tests) {
    const group = classes.get(test.suite) ?? {
      estimate: 0,
      suite: test.suite,
      tests: [],
    };
    group.tests.push(test);
    group.estimate += timings[test.id] ?? fallback;
    classes.set(test.suite, group);
  }
  const shards = Array.from({ length: count }, () => ({
    estimate: 0,
    suites: [],
    tests: [],
  }));
  const weighted = [...classes.values()].toSorted(
    (a, b) => b.estimate - a.estimate || a.suite.localeCompare(b.suite)
  );
  for (const group of weighted) {
    let [lightest] = shards;
    for (const shard of shards) {
      if (shard.estimate < lightest.estimate) {
        lightest = shard;
      }
    }
    lightest.suites.push(group.suite);
    lightest.tests.push(...group.tests);
    lightest.estimate += group.estimate;
  }
  return shards;
};

/// The simulator the lane was given, and a second one of the same model and runtime that the
/// lane owns. The second is created once and kept, so later runs only boot it.
const laneSimulators = () => {
  const { devices } = JSON.parse(
    run(["xcrun", "simctl", "list", "devices", "available", "--json"])
  );
  const all = Object.entries(devices).flatMap(([runtime, list]) =>
    list.map((device) => ({ ...device, runtime }))
  );
  const named = all.filter((device) => device.name === simulator);
  const source = simulatorUdid
    ? all.find((device) => device.udid === simulatorUdid)
    : (named.find((device) => device.state === "Booted") ?? named[0]);
  if (!source) {
    throw new Error(`no available simulator ${simulatorUdid ?? simulator}`);
  }
  const name = `${source.name} (Orbis lane 2)`;
  const second = all.find(
    (device) =>
      device.name === name &&
      device.runtime === source.runtime &&
      device.deviceTypeIdentifier === source.deviceTypeIdentifier
  );
  if (second) {
    return [source, second];
  }
  const udid = run([
    "xcrun",
    "simctl",
    "create",
    name,
    source.deviceTypeIdentifier,
    source.runtime,
  ]).trim();
  return [source, { name, runtime: source.runtime, state: "Shutdown", udid }];
};

/// Runs the journeys on two simulators at once. Xcode's own parallel testing decides for itself
/// how many clones to start, and on a loaded Mac it starts one, so the lane builds once and runs
/// one `test-without-building` per simulator, each with its own share of the journeys.
const runJourneysInParallel = async ({ derived, signing, testEnvironment }) => {
  const simulators = laneSimulators();
  const booting = performance.now();
  const boots = (async () => {
    const results = await Promise.all(
      simulators.map((device) =>
        runConcurrently(["xcrun", "simctl", "bootstatus", device.udid, "-b"])
      )
    );
    return { results, seconds: secondsSince(booting) };
  })();

  const products = path.join(derived, "Build", "Products");
  if (existsSync(products)) {
    for (const file of readdirSync(products)) {
      if (file.endsWith(".xctestrun")) {
        rmSync(path.join(products, file));
      }
    }
  }
  const building = performance.now();
  const build = await runConcurrently(
    [
      "xcodebuild",
      "-project",
      "Orbis.xcodeproj",
      "-scheme",
      "Orbis",
      "-destination",
      `platform=iOS Simulator,id=${simulators[0].udid}`,
      ...signing,
      "-derivedDataPath",
      derived,
      "-only-testing:OrbisUITests",
      "build-for-testing",
    ],
    { cwd: native, env: testEnvironment }
  );
  const buildSeconds = secondsSince(building);
  const booted = await boots;
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    throw new Error(`xcodebuild build-for-testing exited ${build.status}`);
  }
  for (const [index, result] of booted.results.entries()) {
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`simulator ${simulators[index].udid} did not boot`);
    }
  }
  const testRun = readdirSync(products).find((file) =>
    file.endsWith(".xctestrun")
  );
  if (!testRun) {
    throw new Error(`build-for-testing wrote no .xctestrun under ${products}`);
  }

  const timings = readTimings();
  const shards = shardJourneys(journeys(), timings, simulators.length);
  const workers = await Promise.all(
    shards.map(async (shard, index) => {
      const device = simulators[index];
      const directory = `worker-${index + 1}`;
      const bundle = path.join(derived, `result-${directory}.xcresult`);
      rmSync(bundle, { force: true, recursive: true });
      const started = performance.now();
      const result =
        shard.tests.length === 0
          ? { status: 0, stderr: "", stdout: "" }
          : await runConcurrently(
              [
                "xcodebuild",
                "test-without-building",
                "-xctestrun",
                path.join(products, testRun),
                "-destination",
                `platform=iOS Simulator,id=${device.udid}`,
                "-resultBundlePath",
                bundle,
                "-parallel-testing-enabled",
                "NO",
                ...shard.suites.map(
                  (suite) => `-only-testing:OrbisUITests/${suite}`
                ),
              ],
              { cwd: native, env: testEnvironment }
            );
      return {
        bundle,
        device,
        directory,
        result,
        seconds: secondsSince(started),
        shard,
      };
    })
  );

  // A lane-owned simulator is shut down again, so the Mac does not carry its memory between
  // runs. The one the lane was given is left as it was found.
  if (simulators[1].state !== "Booted") {
    spawnSync("xcrun", ["simctl", "shutdown", simulators[1].udid]);
  }

  const suites = new Map();
  let output = build.stdout;
  for (const worker of workers) {
    output += `\n== ${worker.directory}: ${worker.device.name} (${worker.device.udid}) ==\n`;
    output += worker.result.stdout + worker.result.stderr;
    for (const suite of worker.shard.suites) {
      suites.set(suite, {
        directory: worker.directory,
        name: worker.device.name,
      });
    }
    for (const match of worker.result.stdout.matchAll(
      /^Test Case '-\[OrbisUITests\.(?<suite>\w+) (?<test>\w+)\]' (?:passed|failed) \((?<seconds>[\d.]+) seconds\)/gmu
    )) {
      timings[`${match.groups.suite}/${match.groups.test}`] = Number(
        match.groups.seconds
      );
    }
  }
  writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);

  const bundles = workers
    .map((worker) => worker.bundle)
    .filter((bundle) => existsSync(bundle));
  if (bundles.length === 1) {
    renameSync(bundles[0], resultBundle);
  } else if (bundles.length > 1) {
    run([
      "xcrun",
      "xcresulttool",
      "merge",
      ...bundles,
      "--output-path",
      resultBundle,
    ]);
  }

  return {
    failed: workers
      .filter((worker) => worker.result.status !== 0)
      .map((worker) => `${worker.directory} (${worker.device.name})`),
    output,
    record: {
      bootSeconds: booted.seconds,
      buildSeconds,
      workers: workers.map((worker) => ({
        directory: worker.directory,
        estimatedSeconds: Number(worker.shard.estimate.toFixed(3)),
        journeys: worker.shard.tests.map((test) => test.id),
        name: worker.device.name,
        seconds: worker.seconds,
        status: worker.result.status,
        suites: worker.shard.suites,
        udid: worker.device.udid,
      })),
    },
    suites,
  };
};

const dataDirectory = mkdtempSync(path.join(tmpdir(), "orbis-lane-"));
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
    token = randomBytes(32).toString("base64url");
    settingsToken = randomBytes(32).toString("base64url");
    server = spawn("bun", ["scripts/fixture.ts"], {
      cwd: root,
      env: {
        ...process.env,
        ORBIS_COBALT_API_KEY: "lane",
        ORBIS_COBALT_URL: `${seedAddress}/cobalt`,
        ORBIS_FIXTURE_DATA_DIR: dataDirectory,
        ORBIS_FIXTURE_PORT: String(port),
        ORBIS_FIXTURE_SETTINGS_TOKEN: settingsToken,
        ORBIS_FIXTURE_TOKEN: token,
        ORBIS_OPENROUTER_API_KEY: "",
        ORBIS_YOUTUBE_API_KEY: "",
        ORBIS_YTDLP_BIN: "",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [readyChunk] = await once(server.stdout, "data");
    const ready = JSON.parse(readyChunk.toString().split(/\r?\n/u)[0]);
    if (
      ready.address !== address ||
      ready.token !== token ||
      ready.settingsToken !== settingsToken
    ) {
      throw new Error("the fixture printed an invalid ready record");
    }
    await waitForService(address);
    console.log(`lane service: ${address}`);
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
  // xcodegen substitutes these into the scheme's test action, which is how a journey test
  // receives the address and token it types into the connection screen.
  const testEnvironment = {
    ...process.env,
    ORBIS_UI_TEST_ADDRESS: address,
    ORBIS_UI_TEST_SEED_ADDRESS: seedAddress,
    ORBIS_UI_TEST_SETTINGS_TOKEN: settingsToken,
    ORBIS_UI_TEST_TOKEN: token,
  };
  // Ad-hoc signing gives the simulator build the entitlement its keychain needs, while leaving
  // the committed project device-ready. The macOS host cannot ad-hoc sign that entitlement, so
  // the macOS run uses automatic signing with the local development identity from project.yml.
  const signing = macos ? [] : ["CODE_SIGN_IDENTITY=-"];
  let testOutput;
  const testWorkers = new Map();
  let parallelRecord;
  if (parallelJourneys) {
    const parallel = await runJourneysInParallel({
      derived,
      signing,
      testEnvironment,
    });
    testOutput = parallel.output;
    for (const [suite, worker] of parallel.suites) {
      testWorkers.set(suite, worker);
    }
    parallelRecord = parallel.record;
    if (parallel.failed.length > 0) {
      process.stdout.write(testOutput);
      throw new Error(
        `journeys failed on ${parallel.failed.join(" and ")}; result bundle: ${resultBundle}`
      );
    }
  } else {
    testOutput = run(
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
        ...signing,
        "-derivedDataPath",
        derived,
        "-resultBundlePath",
        resultBundle,
        ...only,
        "test",
      ],
      {
        cwd: native,
        env: testEnvironment,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
  }
  process.stdout.write(testOutput);

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
  const lane = {
    elapsedSeconds,
    requestedWorkers: workerCount,
    simulator,
    simulatorUdid,
    workers: [...workers.values()],
  };
  if (parallelRecord) {
    lane.parallel = parallelRecord;
  }
  writeFileSync(
    path.join(shots, "lane.json"),
    `${JSON.stringify(lane, null, 2)}\n`
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
