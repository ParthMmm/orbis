import { SignInCodeSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

export const DEFAULT_API_URL = "https://orbis.p11a.xyz/api";

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

/** Asks the Group for a Host Sign-in Code with Vanta's node key (ADR 0020). */
export const recoverHost = async (input: {
  readonly url: string;
  readonly nodeKey: string;
}) => {
  const response = await fetch(recoveryUrl(input.url), {
    headers: { authorization: `Bearer ${input.nodeKey}` },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Recovery failed (${response.status}). Check ORBIS_NODE_KEY and the API URL.`
    );
  }
  const issued = Schema.decodeUnknownSync(SignInCodeSchema)(
    await response.json()
  );
  console.log(`Sign-in Code for the Host: ${issued.code}`);
  console.log(`Expires at ${issued.expiresAt}.`);
};
