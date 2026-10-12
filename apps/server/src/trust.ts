import { DEFAULT_API_URL, recoverHost } from "./trust-recovery.js";

const usage =
  "Usage: ORBIS_NODE_KEY=<node key> bun src/trust.ts recover [--url <API URL>]";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const [command] = process.argv.slice(2);
try {
  if (command === "recover") {
    // The key comes from the environment so it stays out of shell history and `ps`.
    const nodeKey = process.env.ORBIS_NODE_KEY?.trim();
    if (!nodeKey) {
      throw new Error("Set ORBIS_NODE_KEY to Vanta's node key.");
    }
    await recoverHost({
      nodeKey,
      url: option("url")?.trim() || DEFAULT_API_URL,
    });
  } else {
    console.log(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
