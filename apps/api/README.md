# Orbis API Worker and Group

The Worker at `https://orbis.p11a.xyz/api/*` forwards requests to one SQLite Durable Object named `group`. The Group currently serves only `GET /api/health`, using the health group from `@orbis/contracts`. Other routes return 404. The web client continues to use Vanta until the remaining ADR 0018 tickets and the data cutover are complete.

The portable `Database` service accepts either Drizzle Effect SQLite driver. `createApp({ database })` accepts an injected layer. Existing server callers keep the Bun default. The Group imports only the portable service, the contracts, and the Durable Object driver. It does not load the server app or audio services.

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

Health must return `{"status":"ok"}` and the web page must load. This foundation does not switch the web client's API URL.

To destroy the whole stack:

```sh
cd apps/web
bun run destroy
```

Destroy removes the web and API Workers, custom domain, API route, and Group namespace with all Group data. Export and preserve that data before destroying after the application cutover. Vanta is outside this stack.

## Verify locally

```sh
bun run --filter @orbis/contracts build
bun run --filter @orbis/api test
bun run --filter @orbis/api typecheck
bun run --filter @orbis/server typecheck
cd apps/server
bun test
```

The smoke test runs the Worker and Group in workerd through Miniflare. It checks health, singleton routing, unavailable routes, exact schema equality with a fresh Bun database, injected database use through the server's save route, and persistence after a runtime restart. Its fixture adds schema and persistence routes only to the test bundle. The production bundle has only health. The test also rejects Bun, filesystem, and audio references in the production bundle.

Each run writes `result.json` and its two SQLite databases beneath `.cache/api-group/<run-id>` at the repository root. This is a repeatable local artifact. Live rollout is separate and was not performed by this repository change.
