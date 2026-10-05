import { Schema } from "effect";

const RecoveredKey = Schema.Struct({ id: Schema.String, token: Schema.String });
const recoveryUrl = (base: string): URL => {
  const url = new URL(`${base.replace(/\/$/u, "")}/recovery`);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error("Recovery requires HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use an API URL without credentials, query, or fragment.");
  }
  return url;
};
const accessToken = async (url: URL): Promise<string> => {
  const provided = process.env.ORBIS_ACCESS_TOKEN?.trim();
  if (provided) {
    return provided;
  }
  const proc = Bun.spawn(
    ["cloudflared", "access", "token", `--app=${url.toString()}`],
    { stderr: "ignore", stdout: "pipe" }
  );
  const [text, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 || !text.trim()) {
    throw new Error(
      `Sign in first with: cloudflared access login ${url.toString()}`
    );
  }
  return text.trim();
};
export const recoverRemoteAdmin = async (input: {
  readonly url: string;
  readonly label: string;
}) => {
  const url = recoveryUrl(input.url);
  const token = await accessToken(url);
  const response = await fetch(url, {
    body: JSON.stringify({ label: input.label }),
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "cf-access-token": token,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Recovery failed (${response.status}). Sign in through Cloudflare Access and try again.`
    );
  }
  const key = Schema.decodeUnknownSync(RecoveredKey)(await response.json());
  console.log(`Recovered Host admin key ${key.id}.`);
  console.log(`Key token, shown once: ${key.token}`);
};
