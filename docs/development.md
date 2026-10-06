# Development

Source ownership, local setup, and verification.

## Find the implementation

| Task | Start here |
| --- | --- |
| Routes, request shapes, and derived clients | [`packages/contracts/src/http-api.ts`](../packages/contracts/src/http-api.ts) |
| Shared HTTP handlers | [`apps/server/src/app-core.ts`](../apps/server/src/app-core.ts) |
| Disposable SQLite API dependencies | [`apps/server/src/app.ts`](../apps/server/src/app.ts) and [`scripts/fixture.ts`](../scripts/fixture.ts) |
| Production Cloudflare Group | [`apps/api/src/group.ts`](../apps/api/src/group.ts) and [API README](../apps/api/README.md) |
| Vanta audio-node startup and protocol | [`apps/server/src/node.ts`](../apps/server/src/node.ts), [`audio-node.ts`](../apps/server/src/audio-node.ts), and [operation guide](../deploy/orbis-server/README.md) |
| Audio HTTP listener and API forwarding | [`node-http.ts`](../apps/server/src/node-http.ts) |
| Download selection and retained files | [`download-backends.ts`](../apps/server/src/download-backends.ts) and [`media-store.ts`](../apps/server/src/media-store.ts) |
| Presence actions, the change journal, and feed catch-up | [`presence.ts`](../apps/server/src/presence.ts), [`journal.ts`](../apps/server/src/journal.ts), and [`feed.ts`](../apps/server/src/feed.ts) |
| Identity, trust storage, and administration | [`identity.ts`](../apps/server/src/identity.ts), [`trust-storage.ts`](../apps/server/src/trust-storage.ts), [`trust-writes.ts`](../apps/server/src/trust-writes.ts) (revocation, removal, and Social changes), and [`admin.ts`](../apps/server/src/admin.ts) |
| Web routes and player | [`apps/web/src/routes`](../apps/web/src/routes) and [`player.tsx`](../apps/web/src/components/player/player.tsx) |
| Apple client and project specification | [`apps/apple/Orbis`](../apps/apple/Orbis) and [`project.yml`](../apps/apple/project.yml) |
| Native fixture setup and HTTP client | [`scripts/native-lanes.mjs`](../scripts/native-lanes.mjs), [`seed-lane-audio.mjs`](../scripts/seed-lane-audio.mjs), and [`LaneService.swift`](../apps/apple/OrbisUITests/LaneService.swift) |
| Domain terms and decisions | [CONTEXT.md](../CONTEXT.md) and [ADRs](adr) |

Resolve a filename with `rg --files <directory>` before reading it. Server HTTP tests live beside the implementation in `apps/server/src`; native fixture setup lives in the lane runner. Historical plans in `docs/plans` record earlier build sequences and are not current setup instructions.

## Setup

Requires Bun 1.4.1 and Node.js 24. TypeScript 7 is pinned and patched with Effect diagnostics by the install preparation script. The audio node and disposable HTTP fixtures run on Bun.

```sh
bun install
bun run dev
```

`bun run dev` runs workspace development tasks. The server workspace starts the production audio node and requires its node environment. Web API configuration is in the [web README](../apps/web/README.md#develop). Browser and native journeys start `scripts/fixture.ts` with disposable SQLite and keyed loopback HTTP.

### Server logs

The server writes one structured event per request when the request settles: request id, method, path with the query string removed, status, outcome, and elapsed time. An `Effect.log*` call made while handling a request is folded into that event instead of a second line.

Authorization headers, cookies, request bodies, source links, and raw error stacks are never recorded, and credential-shaped values are redacted before output. Redaction follows key names, so a credential written as free text can still reach a line: treat logged free text as public.

`NODE_ENV` sets the event `environment`, which defaults to `development`. In production each event is one JSON line, where `info` goes to standard output and `warn` and `error` go to standard error; development prints readable lines. The wiring lives in `apps/server/src/logging.ts`. `createApp({ logging })` overrides the environment, quiets output (`silent`), or receives every event (`onEvent`), which the tests use.

## Checks

Run `bun run check` locally or in CI for cached lint, formatting, TypeScript, tests, and Effect diagnostics. Turbo runs independent tasks in parallel, bounded by the available CPU count, and builds shared contracts before consumers. `bun run check:force` bypasses task-cache reads. `bun run fix` applies Ultracite fixes; it is never cached.

GitHub Actions cancels superseded runs and runs React Doctor alongside the quality job. Bun downloads and Turbo results use separate caches; each workflow run saves a new Turbo snapshot. Cache restores stay within the same OS and CPU architecture. No remote-cache account is required. Typechecks use separate incremental files so they do not race with builds.

The quality workflow also runs the Swift style check and `swift test` for `OrbisDesign` on a macOS runner, so the Swift package is verified even when no Mac is present.

Individual checks and packaging remain available:

```sh
bun run typecheck
bun run test
bun run build
bun run format:check
```

## Verification lanes

Build shared contracts before running a focused lane from the repository root:

```sh
	bun run --filter @orbis/contracts build
```

| Change | Command from repo root | Evidence and prerequisites |
| --- | --- | --- |
| Bun HTTP handlers | `bun run --filter @orbis/server test` | Real database HTTP tests in `apps/server/src`; retain command output for failures |
| Cloudflare Group and audio node | `bun run --filter @orbis/api test` | Workerd journeys write `.cache/api-group`, `.cache/audio-node`, `.cache/api-grants`, and `.cache/api-recovery`; requires ffmpeg and ffprobe |
| Group data transfer | `bun run --filter @orbis/api test:transfer` | See [data transfer](data-transfer.md) for restore and comparison artifacts |
| Web client | `bun run --filter @orbis/web test` | Production browser journeys and artifacts listed in [web verification](../apps/web/README.md#verify-the-migration); install Chromium with `bun x playwright install chromium` |
| Apple client | `bun run native:lanes --journeys` | Simulator journeys; see [native clients](#native-clients) for outputs and required tools |

These local checks use disposable storage. Record production acceptance separately on the issue.

### Retain verification evidence

Before rerunning a lane, copy its logs, result JSON, screenshots, and result bundles to a unique directory for that run. Native runs replace `apps/apple/DerivedData/result.xcresult` and the screenshot output directory. Preserve the xcresult and console output even when a failed run exports no screenshots.

Record the commit, exact command, target platform and simulator ID, result, and artifact path together. For a failure, include the failed test and source line from the log or result bundle. Link this record from the issue or PR so the next agent can find it without reading the session history. Keep credentials out of artifacts.

## Native clients

`apps/apple/Orbis` builds one SwiftUI app for iOS and macOS from an xcodegen specification. The generated project and derived data are not tracked. Native lanes require macOS, Xcode, xcodegen, and an available simulator. Use the configured device host when working from Linux.

```sh
bun run native:lanes          # unit tests and native journeys against a temporary service
bun run native:lanes --unit   # unit tests only
```

A lane starts a temporary Orbis service with its own database and trust store, pairs a device, generates the project with that address and token, runs the tests, and exports the screenshots the journeys attached. Open the generated `apps/apple/Orbis.xcodeproj` in Xcode. Build output and `result.xcresult` live under `apps/apple/DerivedData`.

Full and unit lanes run `bun run native:format` first. Journeys-only and `--only` runs leave that check to unit lanes and CI. The style command checks Swift sources with the Xcode toolchain's swift-format against `apps/apple/.swift-format`. swift-format ships with Xcode, so the native style gate needs no install. The check writes nothing; to fix drift, run `xcrun swift-format format --in-place` on the changed files.

The runner prints its screenshot directory, defaulting to `orbis-lane-shots` in the host's system temporary directory. Set `--out <unique-directory>` to choose it. Successful exports include `xcodebuild.log`, `lane.json`, attachments, and worker manifests. Follow [evidence retention](#retain-verification-evidence) before another run replaces the result bundle. For manual checks, read [UI verification](agents/ui-verification.md).

## Releases

A release is a version tag with generated notes. It has no binaries: signing, notarization, and installers are not set up.

1. Merge the changes to `main` and wait for CI to pass.
2. Tag the commit and push the tag. Use `vMAJOR.MINOR.PATCH`; a suffix such as `-rc.1` marks a pre-release.

```sh
git switch main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow refuses a tag that is not on `main`, then creates the GitHub Release with notes built from the merged pull requests. Delete a wrong tag with `git push origin :refs/tags/<tag>` and `gh release delete <tag>`.
