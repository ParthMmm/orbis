import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";

/** Copies the database and the trust store into `outputDirectory` and keeps the newest `keep`. */
export const backUp = (input: {
  readonly dataDirectory: string;
  readonly keep?: number;
  readonly now?: Date;
  readonly outputDirectory: string;
}): string => {
  const { dataDirectory, outputDirectory } = input;
  const stamp = (input.now ?? new Date())
    .toISOString()
    .replaceAll(/[:.]/gu, "-");
  const target = path.join(outputDirectory, stamp);
  mkdirSync(target, { recursive: true });
  // VACUUM INTO writes a consistent snapshot while the service keeps writing.
  const database = new Database(path.join(dataDirectory, "library.sqlite"), {
    readonly: true,
  });
  try {
    database.run("VACUUM INTO ?", [path.join(target, "library.sqlite")]);
  } finally {
    database.close();
  }
  const devices = path.join(dataDirectory, "devices.json");
  if (existsSync(devices)) {
    copyFileSync(devices, path.join(target, "devices.json"));
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- The ES2022 library has no toSorted.
  const backups = [...readdirSync(outputDirectory)].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const old of backups.slice(
    0,
    Math.max(0, backups.length - (input.keep ?? 14))
  )) {
    rmSync(path.join(outputDirectory, old), { force: true, recursive: true });
  }
  return target;
};

if (import.meta.main) {
  const output = process.argv.at(2);
  if (output === undefined) {
    console.error(
      "Usage: ORBIS_DATA_DIR=<dir> bun src/backup.ts <output directory>"
    );
    process.exitCode = 2;
  } else {
    console.log(
      backUp({
        dataDirectory: path.resolve(process.env.ORBIS_DATA_DIR ?? "data"),
        outputDirectory: path.resolve(output),
      })
    );
  }
}
