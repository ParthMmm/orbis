import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";
import type { MiniflareOptions } from "miniflare";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-recovery",
  crypto.randomUUID()
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
const issuer = "https://orbis-test.cloudflareaccess.com";
const audience = "recovery-audience";
const email = "host@example.test";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: "RS256",
  kid: "fixture",
  use: "sig",
};
const now = Math.floor(Date.now() / 1000);
const token = (claims: Record<string, string | number | string[]> = {}) =>
  new SignJWT({
    aud: [audience],
    email,
    exp: now + 600,
    iat: now,
    iss: issuer,
    sub: "host-identity",
    type: "app",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(privateKey);
const valid = await token();
const options = {
  bindings: {
    ACCESS_AUDIENCE: audience,
    ACCESS_ISSUER: issuer,
    AUDIO_NODE_URL: "https://audio.example",
    RECOVERY_HOST_EMAIL: email,
    STREAM_GRANT_SECRET: "ab".repeat(32),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  outboundService: (request) => {
    assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  },
  script: await output.text(),
} satisfies MiniflareOptions;
let runtime = new Miniflare(options);
const recovery = (jwt?: string, route = "/api/recovery") => {
  const headers = new Headers({ "content-type": "application/json" });
  if (jwt) {
    headers.set("Cf-Access-Jwt-Assertion", jwt);
  }
  return runtime.dispatchFetch(`http://orbis${route}`, {
    body: JSON.stringify({ label: "Recovery smoke" }),
    headers,
    method: "POST",
  });
};
try {
  const missing = await recovery();
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.has("x-recovery-group"), false);
  const spoofed = await runtime.dispatchFetch("http://orbis/api/recovery", {
    headers: {
      "CF-Access-Jwt-Assertion": "forged",
      "Cf-Access-Authenticated-User-Email": email,
      cookie: "CF_Authorization=forged",
    },
    method: "POST",
  });
  assert.equal(spoofed.status, 401);
  assert.equal(spoofed.headers.has("x-recovery-group"), false);
  const invalidClaims = [
    { aud: "wrong-audience" },
    { email: "other@example.test" },
    { iss: "https://attacker.example" },
    { exp: now - 1 },
    { nbf: now + 600 },
    { type: "service" },
  ];
  await Promise.all(
    invalidClaims.map(async (claims) => {
      const invalid = await recovery(await token(claims));
      assert.equal(invalid.status, 401);
      assert.equal(invalid.headers.has("x-recovery-group"), false);
    })
  );
  const noExpiry = await new SignJWT({
    aud: [audience],
    email,
    iat: now,
    iss: issuer,
    sub: "host-identity",
    type: "app",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(privateKey);
  const missingExpiry = await recovery(noExpiry);
  assert.equal(missingExpiry.status, 401);
  const forged = `${valid.slice(0, -8)}abcdefgh`;
  const forgedResponse = await recovery(forged);
  assert.equal(forgedResponse.status, 401);
  const directGroup = await recovery(undefined, "/direct-group");
  assert.equal(directGroup.status, 401);
  const success = await recovery(valid);
  assert.equal(success.status, 201, await success.clone().text());
  assert.equal(success.headers.get("cache-control"), "no-store");
  const key = await success.json();
  assert.equal(key.scope, "admin");
  assert.equal(key.personId, "host");
  assert.ok(key.token);
  const admin = await runtime.dispatchFetch("http://orbis/api/admin/people", {
    headers: { authorization: `Bearer ${key.token}` },
  });
  assert.equal(admin.status, 200, await admin.clone().text());
  const accessOnly = await runtime.dispatchFetch(
    "http://orbis/api/admin/people",
    { headers: { "Cf-Access-Jwt-Assertion": valid } }
  );
  assert.equal(accessOnly.status, 403);
  const readRecovery = await runtime.dispatchFetch(
    "http://orbis/api/recovery",
    { headers: { "Cf-Access-Jwt-Assertion": valid } }
  );
  assert.equal(readRecovery.status, 405);
  const replacement = await recovery(valid);
  assert.equal(replacement.status, 201);
  const replacementKey = await replacement.json();
  assert.notEqual(replacementKey.token, key.token);
  const address = await runtime.ready;
  const cli = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../server/src/trust.ts"),
      "recover",
      "--url",
      `${address.origin}/api`,
      "--label",
      "CLI recovery",
    ],
    {
      cwd: artifact,
      env: {
        ...process.env,
        ORBIS_ACCESS_TOKEN: valid,
        ORBIS_DATA_DIR: path.join(artifact, "no-local-database"),
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [cliText, cliError, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  assert.equal(exitCode, 0, cliError);
  assert.equal(cliText.includes(valid), false);
  assert.match(cliText, /Key token, shown once:/u);
  const localFiles = await readdir(artifact);
  assert.equal(localFiles.includes("no-local-database"), false);
  await runtime.dispose();
  runtime = new Miniflare({
    ...options,
    bindings: { ...options.bindings, ACCESS_AUDIENCE: "" },
  });
  const unconfigured = await recovery(valid);
  assert.equal(unconfigured.status, 401);
  assert.equal(unconfigured.headers.has("x-recovery-group"), false);
  await writeFile(
    path.join(artifact, "result.json"),
    JSON.stringify(
      {
        accessOnlyRejected: true,
        adminKeyWorks: true,
        cliRecovery: true,
        forgedClaimsRejected: invalidClaims.length + 2,
        groupDefense: true,
        missingConfigurationRejected: true,
        missingSessionStoppedBeforeGroup: true,
        recoveredKeyId: key.id,
        replacement: true,
      },
      null,
      2
    )
  );
  console.log(`Recovery smoke passed. ${path.join(artifact, "result.json")}`);
} finally {
  await runtime.dispose();
}
