const usage = "Usage: bun src/trust.ts recover --url <API URL> --label <name>";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const required = (name: string): string => {
  const value = option(name)?.trim();
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
};

const [command] = process.argv.slice(2);
try {
  if (command === "recover") {
    const { recoverRemoteAdmin } = await import("./trust-recovery.js");
    await recoverRemoteAdmin({
      label: required("label"),
      url: required("url"),
    });
  } else {
    console.log(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
