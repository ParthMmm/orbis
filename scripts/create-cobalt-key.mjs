import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const defaultPath = path.resolve("deploy/cobalt/keys.json");

const usage = () =>
  `Usage: node scripts/create-cobalt-key.mjs [--output <path>] [--force]\n`;

const parseArgs = (argv) => {
  let output = defaultPath;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--output") {
      output = argv[index + 1];
      if (!output || output.startsWith("--")) {
        throw new Error("--output needs a value");
      }
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { force, output: path.resolve(output) };
};

const main = async () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Usage error: ${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const key = randomUUID();
  const contents = `${JSON.stringify(
    {
      [key]: {
        allowedServices: ["youtube", "soundcloud"],
        limit: 10,
        name: "orbis-cobalt-trial",
      },
    },
    null,
    2
  )}\n`;
  await mkdir(path.dirname(options.output), { recursive: true });
  try {
    await writeFile(options.output, contents, {
      flag: options.force ? "w" : "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      console.error(
        `Refusing to replace ${options.output}; use --force to rotate the key.`
      );
      return 2;
    }
    throw error;
  }
  await chmod(options.output, 0o600);
  console.log(`Created ${options.output} with mode 0600.`);
  console.log(`API key (store securely; do not commit): ${key}`);
  return 0;
};

try {
  process.exitCode = await main();
} catch {
  console.error("Could not create Cobalt API key.");
  process.exitCode = 1;
}
