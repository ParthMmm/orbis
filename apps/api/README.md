# Orbis API Worker and Group

The Worker at `https://orbis.p11a.xyz/api/*` forwards requests to one SQLite Durable Object named `group`. The Group serves every route from `@orbis/contracts`. Health is public; library and administration routes use the existing key and social visibility rules. The Group has owned production data since the 2026-10-03 cutover. Vanta runs the audio node and forwards requests from the old API address. [#195](https://github.com/ParthMmm/orbis/issues/195) tracks the remaining production acceptance checks.

`createPortableApp` composes the HTTP routes with an injected database, Audio service, audio response, audio release operation, and stream signing secret. The Bun `createApp` wrapper supplies the local implementations. The Group supplies its SQLite driver and trust adapter, persists Download requests without running a local worker, and redirects audio to the audio node. Its bundle excludes Bun, filesystem access, and local download backends.

Presence, Queue signals, and the failed-key limit live in the Group's memory. Sign-in Codes live in the trust tables, so a restart or eviction keeps them. The limit uses `CF-Connecting-IP`, counts an IPv6 client by its /64 block, and adds one Group-wide ceiling on failed sign-in attempts. Events retain the 30-second heartbeat and end when the caller's key is revoked. Requests produce JSON logs.

## Worker configuration

Alchemy enables `nodejs_compat` for the portable crypto APIs. The deploy reads these values from its environment:

- `STREAM_GRANT_SECRET` is the 64-character hex encoding of the existing 32-byte `stream-grant.key`. Preserve that key so existing grants remain valid.
- `AUDIO_NODE_URL` is the audio node's HTTPS origin.
- `YOUTUBE_API_KEY` and `OPENROUTER_API_KEY` configure metadata and title revision.
- `VERSOS_URL` and `VERSOS_API_KEY` configure Tracklist discovery. `VERSOS_URL` defaults to `https://versos.studio`.

Alchemy stores API keys and the stream secret as Worker secrets. A deploy sends only the secrets set in its environment. Each unset secret keeps the value already on the Worker, so a deploy needs only `AUDIO_NODE_URL` and the secrets it changes. A Worker with no stored value for a provider key disables that provider. A first deploy must set `STREAM_GRANT_SECRET`. SoundCloud uses its public metadata endpoint and requires no key. No credentials are embedded in the Worker bundle.

## Migrations

`src/migrations.json` embeds every `apps/server/drizzle/*/migration.sql` file in name order. The Group applies them through Drizzle's Durable Object migrator during startup. Its constructor blocks incoming requests until the database is ready. Restarting the Group preserves its SQLite database and does not replay applied migrations.

After adding a migration, regenerate the bundle from the repository root:

```sh
bun apps/api/scripts/migrations.ts
bun apps/api/scripts/migrations.ts --check
```

The API build and web deploy fail when the generated bundle is stale. Cloudflare does not support Bun's legacy `PRAGMA user_version`; the Group uses Drizzle's migration table.

## Deploy and destroy

The API shares the existing `OrbisWeb` Alchemy stack, `prod` stage, and Cloudflare state with the web client. `Web` keeps its identity. `Api` owns the `/api/*` zone route and the `GROUP` binding, whose exported SQLite class is `Group`. Use the Cloudflare OAuth profile described in the [web deploy README](../web/README.md#sign-in-to-cloudflare).

```sh
bun install --frozen-lockfile
bun run --filter @orbis/contracts build
cd apps/web
bun ../api/scripts/migrations.ts --check
./node_modules/.bin/alchemy deploy --stage prod --dry-run
bun run deploy
```

After deploying, confirm both routes and record the results:

```sh
curl --fail https://orbis.p11a.xyz/api/health
curl --fail --output /dev/null https://orbis.p11a.xyz/
```

Health must return `{"status":"ok"}` and the web page must load. Deploying this API does not switch the web client's API URL.

To destroy the whole stack:

```sh
cd apps/web
bun run destroy
```

Destroy removes the web and API Workers, custom domain, API route, and Group namespace with all Group data. Export and preserve that data before destroying after the application cutover. Vanta is outside this stack.

## Verify locally

The workerd journey runs in Miniflare with a disposable SQLite Group. It signs in, saves a Set, edits a Playlist, checks queued Downloads, reads an event and its heartbeat, revokes the event key, checks rate limits by address, and restarts the Group. It also compares the Group schema with Bun and composes the same portable application and queue-only Audio service with a real Bun database. The journey writes `.cache/api-group/<run>/result.json` at the repository root. Its test-only seed and inspection routes are excluded from the production bundle.

```sh
bun run --filter @orbis/contracts build
bun run --filter @orbis/api test
bun run --filter @orbis/api typecheck
bun run --filter @orbis/server typecheck
cd apps/server
bun test
```

The API test command also runs the audio node, grant, and recovery journeys against disposable Group storage. Their artifacts live under `.cache/audio-node`, `.cache/api-grants`, and `.cache/api-recovery`. Live rollout requires separate production checks.

## Recover Host access

Recovery gives the Host a Sign-in Code when no signed-in device is left ([ADR 0020](../../docs/adr/0020-sign-in-by-group-passcode-and-sign-in-code.md)). It uses Vanta's node key, which can already export all Group data, so recovery adds no new power.

On Vanta, load the node key from the backup environment file and run the command:

```sh
cd ~/Developer/orbis-service
bash -c 'set -a; . ~/.config/orbis-backup.env; exec bun run --cwd apps/server trust recover'
```

The command calls `POST https://orbis.p11a.xyz/api/recovery`. Use `--url <API URL>` to call another Group. It reads the key only from `ORBIS_NODE_KEY`, never from its arguments, so the key stays out of shell history and the process list. It prints the code and its expiry time. Type the code on the new device within 10 minutes. The device receives its own daily key for the Host.

`/api/recovery` accepts only `POST`. The route refuses a missing, unknown, or daily key. Responses carry `Cache-Control: no-store`. Recovery restores the Host Person if it was removed, or creates it in an empty Group. It does not create or revoke keys, so revoke a lost device from Settings after signing in.

A Host who loses every device and access to Vanta cannot recover without redeploying.

The next deploy deletes the Cloudflare Access application for `/api/recovery`. It keeps the one-time PIN provider that `RECOVERY_CREATE_OTP` created. Delete that provider in the Cloudflare dashboard if nothing else uses it.

`bun apps/api/e2e/recovery.ts` runs a workerd HTTP journey against a disposable Group. It checks that missing, unknown, and daily keys are refused, that the node key returns a code, that the code redeems once for a Host key that reaches `/admin/people`, that the node key cannot call a client route, and that the CLI reads the key only from its environment. The result is `.cache/api-recovery/<run>/result.json`; it contains no keys or codes.

The web deployment also passes `AUDIO_NODE_URL` as `ORBIS_AUDIO_URL`, so its media Content Security Policy can follow Group audio redirects to the node.
