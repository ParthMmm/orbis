#!/usr/bin/env node
// Writes ~/.orbis/config.json, which a Debug build of the Apple app reads for the service
// address and a device token. The file lives outside the repository so no credential is
// committed, and the app only reads it when nothing is stored.
//
//   node scripts/orbis-device-config.mjs --address https://host:8444 --token-file ~/.orbis/token
//   ORBIS_SERVICE_ADDRESS=... ORBIS_DEVICE_TOKEN=... node scripts/orbis-device-config.mjs
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const address = argument("address") ?? process.env.ORBIS_SERVICE_ADDRESS;
const tokenFile = argument("token-file");
const token =
  argument("token") ??
  process.env.ORBIS_DEVICE_TOKEN ??
  (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : undefined);

if (!address || !token) {
  console.error(
    "Needs an address and a token. Pair a device with apps/server/src/trust.ts, then pass\n" +
      "  --address <url> --token-file <path>, or set ORBIS_SERVICE_ADDRESS and ORBIS_DEVICE_TOKEN."
  );
  process.exitCode = 1;
} else {
  const directory = path.join(os.homedir(), ".orbis");
  const file = path.join(directory, "config.json");
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ deviceToken: token, serviceAddress: address }, null, 2)}\n`
  );
  await chmod(file, 0o600);
  console.log(`Wrote ${file}`);
  console.log(`  serviceAddress ${address}`);
  console.log(`  deviceToken    ${token.length} characters, not printed`);
}
