// Host recovery with Vanta's node key (ADR 0020), through workerd over HTTP.
//
// Ways it could fail, each covered below:
// - A request without a key, with an unknown key, or with a friend's daily
//   key gets a Sign-in Code.
// - GET reads or issues anything.
// - The response is cacheable, or the code does not redeem to a Host key.
// - The redeemed key cannot reach the Host's routes, or the code works twice.
// - The node key reaches a client route.
// - The CLI takes the key from argv, prints it, or fails to print the code.
// - The artifact holds a key or a code.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Miniflare } from "miniflare";

const NODE_KEY = "vanta-node-token";
const FRIEND_KEY = "friend-daily-token";
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u;

const run = crypto.randomUUID();
const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-recovery",
  run
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "recovery-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  script: await output.text(),
});
const call = (
  route: string,
  options: { method?: string; key?: string; body?: unknown } = {}
) => {
  const headers = new Headers({ "CF-Connecting-IP": "192.0.2.1" });
  if (options.key) {
    headers.set("authorization", `Bearer ${options.key}`);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "GET",
  });
};
const statusOf = async (response: ReturnType<typeof call>) => {
  const settled = await response;
  return settled.status;
};
const recover = (key?: string) => call("/recovery", { key, method: "POST" });
const redeem = (code: string) =>
  call("/sign-in/code", {
    body: { code, label: "Recovered phone" },
    method: "POST",
  });

try {
  assert.equal(await statusOf(call("/__seed")), 200);

  const rejected = {
    daily: await statusOf(recover(FRIEND_KEY)),
    missing: await statusOf(recover()),
    unknown: await statusOf(recover("not-a-key")),
  };
  assert.deepEqual(rejected, { daily: 403, missing: 403, unknown: 401 });
  const read = await call("/recovery", { key: NODE_KEY });
  assert.equal(read.status, 405);
  assert.equal(read.headers.get("allow"), "POST");

  const recovered = await recover(NODE_KEY);
  assert.equal(recovered.status, 201, await recovered.clone().text());
  assert.equal(recovered.headers.get("cache-control"), "no-store");
  const issued = await recovered.json();
  assert.match(issued.code, CODE);
  assert.ok(Date.parse(issued.expiresAt) > Date.now() + 9 * 60 * 1000);

  const signedIn = await redeem(issued.code);
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const { key, person } = await signedIn.json();
  assert.deepEqual(person, { id: "host", username: "host" });
  const me = await call("/me", { key }).then((response) => response.json());
  assert.equal(me.host, true);
  const people = await call("/admin/people", { key });
  assert.equal(people.status, 200, await people.clone().text());
  assert.equal(await statusOf(redeem(issued.code)), 404);

  const nodeOnClient = await statusOf(call("/me", { key: NODE_KEY }));
  assert.equal(nodeOnClient, 403);

  const address = await runtime.ready;
  const cli = async (env: Record<string, string | undefined>) => {
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../server/src/trust.ts"),
        "recover",
        "--url",
        `${address.origin}/api`,
      ],
      { cwd: artifact, env, stderr: "pipe", stdout: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, stdout };
  };
  const { ORBIS_NODE_KEY: _unset, ...environment } = process.env;
  const withoutKey = await cli(environment);
  assert.equal(withoutKey.exitCode, 1);
  assert.match(withoutKey.stderr, /ORBIS_NODE_KEY/u);
  const fromCli = await cli({ ...environment, ORBIS_NODE_KEY: NODE_KEY });
  assert.equal(fromCli.exitCode, 0, fromCli.stderr);
  assert.equal(fromCli.stdout.includes(NODE_KEY), false);
  const cliCode = /Sign-in Code for the Host: (?<code>\S+)/u.exec(
    fromCli.stdout
  )?.groups?.code;
  assert.ok(cliCode);
  assert.match(cliCode, CODE);
  assert.match(fromCli.stdout, /Expires at /u);
  assert.equal(await statusOf(redeem(cliCode)), 200);

  const resultPath = path.join(artifact, "result.json");
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        cliNeedsEnvironmentKey: true,
        cliRecovery: true,
        codeSingleUse: true,
        getRefused: read.status,
        nodeKeyOnClientRoute: nodeOnClient,
        recoveredKeyReachesAdmin: true,
        recoveryStatus: recovered.status,
        rejected,
        run,
      },
      null,
      2
    )
  );
  const saved = await readFile(resultPath, "utf-8");
  for (const secret of [NODE_KEY, FRIEND_KEY, key, issued.code, cliCode]) {
    assert.equal(saved.includes(secret), false);
  }
  console.log(`Recovery journey passed. ${resultPath}`);
} finally {
  await runtime.dispose();
}
