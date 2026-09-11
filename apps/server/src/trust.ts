import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashToken, readDevicesStrict } from "./identity.js";
import type { DeviceRecord } from "./identity.js";

const usage = `Usage:
  bun src/trust.ts add --label "<name>" [--devices <path>]
  bun src/trust.ts list [--devices <path>]
  bun src/trust.ts remove --id <id> [--devices <path>]

The default store is devices.json beside the library database, so ORBIS_DATA_DIR
sets it for the server and this tool at once. Adding prints the device token once.`;

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const devicesPath = (): string =>
  path.resolve(
    option("devices") ??
      path.join(process.env.ORBIS_DATA_DIR ?? "data", "devices.json")
  );

const isMissingFile = (error: Error): boolean =>
  "code" in error && error.code === "ENOENT";

const readStore = (target: string): readonly DeviceRecord[] => {
  try {
    return readDevicesStrict(target);
  } catch (error) {
    if (error instanceof Error && isMissingFile(error)) {
      return [];
    }
    throw new Error(
      `${target} could not be read as a trust store, so it was left untouched.`,
      { cause: error }
    );
  }
};

const write = (target: string, devices: readonly DeviceRecord[]) => {
  const temporary = `${target}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ devices, version: 1 }, null, 2)}\n`,
    { mode: 0o600 }
  );
  // A rename is atomic, so a running server never reads a half-written store.
  renameSync(temporary, target);
};

const add = (target: string) => {
  const label = option("label")?.trim();
  if (!label) {
    throw new Error("--label is required.");
  }
  const token = randomBytes(32).toString("base64url");
  const device: DeviceRecord = {
    addedAt: new Date().toISOString(),
    id: randomBytes(6).toString("hex"),
    label,
    tokenHash: hashToken(token),
  };
  write(target, [...readStore(target), device]);
  console.log(`Enrolled ${device.id} (${label}) in ${target}.`);
  console.log(`Device token, shown once: ${token}`);
};

const list = (target: string) => {
  const devices = readStore(target);
  if (devices.length === 0) {
    console.log(`No paired devices in ${target}.`);
    return;
  }
  for (const device of devices) {
    console.log(`${device.id}\t${device.label}\t${device.addedAt}`);
  }
};

const remove = (target: string) => {
  const id = option("id");
  if (!id) {
    throw new Error("--id is required.");
  }
  const devices = readStore(target);
  const remaining = devices.filter((device) => device.id !== id);
  if (remaining.length === devices.length) {
    throw new Error(`No paired device with id ${id}.`);
  }
  write(target, remaining);
  console.log(`Removed ${id}. It stops working on the next request.`);
};

const [command] = process.argv.slice(2);
const target = devicesPath();

try {
  if (command === "add") {
    add(target);
  } else if (command === "list") {
    list(target);
  } else if (command === "remove") {
    remove(target);
  } else {
    console.log(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
