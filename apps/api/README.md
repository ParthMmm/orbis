# Orbis API Worker and Group

The Worker at `https://orbis.p11a.xyz/api/*` forwards requests to one SQLite Durable Object named `group`. The Group serves every route from `@orbis/contracts`. Health is public; library and administration routes use the existing key and social visibility rules. The Group has owned production data since the 2026-10-03 cutover. Vanta runs the audio node and forwards requests from the old API address. [#195](https://github.com/ParthMmm/orbis/issues/195) tracks the remaining production acceptance checks.

`createPortableApp` composes the HTTP routes with an injected database, Audio service, audio response, audio release operation, and stream signing secret. The Bun `createApp` wrapper supplies the local implementations. The Group supplies its SQLite driver and trust adapter, persists Download requests without running a local worker, and redirects audio to the audio node. Its bundle excludes Bun, filesystem access, and local download backends.

Presence, Queue signals, Device Links, and the failed-key limit live in the Group. The limit uses `CF-Connecting-IP`. Events retain the 30-second heartbeat and end when the caller's key is revoked. Requests produce JSON logs.

The client change feed (ADR 0019) has two transports with one message set. A daily key mints a 30-second single-use ticket with `POST /events/tickets` and offers it as the subprotocol `orbis.ticket.<ticket>` beside `orbis.feed.v1` on `GET /events/socket`. The Group accepts that socket under the `feed` hibernation tag, separate from the audio node's `node` tag, and keeps only the connection, key, and Person in its attachment. Each socket's cursor and unacknowledged sends live in `feed_connections`, so a socket survives eviction. The exact text `{"kind":"ping"}` gets an automatic `{"kind":"pong"}` that does not wake the Group. `GET /events/live` serves the same messages over SSE with the Bearer key and an optional `cursor` query, and keeps the heartbeat. The Vanta forwarder drops upgrade headers, so a socket through Vanta answers 426 and clients use SSE there.

## Worker configuration

Alchemy enables `nodejs_compat` for the portable crypto APIs. Configure these values in the deploy environment before deploying:

- `STREAM_GRANT_SECRET` is the 64-character hex encoding of the existing 32-byte `stream-grant.key`. Preserve that key so existing grants remain valid.
- `AUDIO_NODE_URL` is the audio node's HTTPS origin.
- `YOUTUBE_API_KEY` and `OPENROUTER_API_KEY` configure metadata and title revision.
- `VERSOS_URL` and `VERSOS_API_KEY` configure Tracklist discovery.

Alchemy stores API keys and the stream secret as Worker secrets. Optional provider keys default to empty and disable that provider. SoundCloud uses its public metadata endpoint and requires no key. No credentials are embedded in the Worker bundle.

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

Set `RECOVERY_ENABLED=true` after verifying the Host email and Access team URL. Until enabled, recovery returns `401` and Alchemy creates no Access resources. Alchemy creates an Access application for exactly `orbis.p11a.xyz/api/recovery`. Its allow policy names `RECOVERY_HOST_EMAIL`, permits only the email one-time PIN provider, and expires sessions after 15 minutes. Other API paths keep Bearer-key authentication. Set `ACCESS_ISSUER` to the account's exact `https://<team>.cloudflareaccess.com` origin. Alchemy passes the recovery application's audience to the Worker as `ACCESS_AUDIENCE` and exports `recoveryAudience` in the deployment outputs.

By default the stack looks up the account's existing one-time PIN provider without managing it. If the account has none, explicitly set `RECOVERY_CREATE_OTP=true` to create one. Keep that setting while the stack manages the provider. A created provider has a retain policy, so removing the declaration or destroying this stack cannot delete an account login method that another application may use. Existing providers never require adoption.

Review the plan with the actual Host email, issuer, and existing API configuration before deployment:

```sh
cd apps/web
bun run deploy --dry-run
```

After deployment, sign in with the Host email and emailed code, then mint an admin key:

```sh
cloudflared access login https://orbis.p11a.xyz/api/recovery
bun run --cwd apps/server trust recover --url https://orbis.p11a.xyz/api --label "Host recovery"
```

On a headless machine, open the login URL that `cloudflared` prints on another device. The recovery command reads the cached application token with `cloudflared access token`, calls the protected endpoint, and prints the new admin key once. Store that key in the password manager and paste it into the web admin page. For an existing headless Access session, the command also accepts `ORBIS_ACCESS_TOKEN` through the environment. Do not put it in command arguments or logs; unset it after use.

Recovery creates the Host when the Group is empty and mints a replacement if an old admin key's plaintext is lost. It preserves existing keys, so revoke lost keys from the admin page after signing in. The recovery command does not open or write a local database. `GET /api/recovery` cannot read data.

The Worker rejects missing or invalid Access JWTs before calling the Group. The Group independently verifies the signature, issuer, audience, expiry, application-token type, and Host email before minting a key. The `Cf-Access-Authenticated-User-Email` header alone grants no access. These checks also apply through a `workers.dev` address that has no Access application in front of it. They follow Cloudflare's [JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and [CLI authentication flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/).

`bun apps/api/e2e/recovery.ts` runs a real workerd HTTP journey with a temporary signing key and intercepted public-key endpoint. It checks rejected claims, origin protection, first and replacement admin keys, normal-route isolation, and the CLI without a local database. The result is `.cache/api-recovery/<run>/result.json`; it contains no JWTs or key tokens. A local success does not verify the live email-code flow or deployed Access policy.

The web deployment also passes `AUDIO_NODE_URL` as `ORBIS_AUDIO_URL`, so its media Content Security Policy can follow Group audio redirects to the node.
