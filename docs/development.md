# Development

How to run, check, and package Orbis locally.

## Setup

Requires Bun 1.4.1 and Node.js 24 (Electron Forge and smoke tooling). TypeScript 7 is pinned and patched with Effect diagnostics by the install preparation script. The server runs on Bun, not Node.js.

```sh
bun install
bun run dev
```

The desktop connects to `http://127.0.0.1:4310`. Run only the API with `bun run --filter @orbis/server dev`. Run only the desktop with `bun run --filter @orbis/desktop dev`.

The server stores `library.sqlite` under `data/` in its working directory (`apps/server/data/` with the workspace scripts). Set `ORBIS_DATA_DIR` to an absolute path for a stable custom location. `ORBIS_PORT` overrides the loopback port; set the same value for both processes. This development setup does not launch a bundled server from the packaged desktop app.

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
bun run smoke:desktop
bun run format:check
```

Run the build before the smoke check. The smoke check launches Electron and a separate Bun server on an ephemeral port, uses a temporary database, and cleans up both processes and data. It leaves a screenshot in the system temporary directory. It needs a desktop session, not a headless shell. Desktop renderer changes that affect saving, filtering, empty states, title editing, or deletion are not complete until `bun run smoke:desktop` has passed locally; that gate is documented rather than a macOS CI job because the check requires a real desktop session.

Desktop builds package the current host platform into `apps/desktop/out/`. Signing, installers, and cross-platform release automation are not configured. Server builds need Bun and installed workspace dependencies.

## Native clients

`apps/apple/Orbis` builds one SwiftUI app for iOS and macOS from an xcodegen specification. The generated project and derived data are not tracked.

```sh
bun run native:lanes          # unit tests and native journeys against a temporary service
bun run native:lanes --unit   # unit tests only
```

A lane starts a temporary Orbis service with its own database and trust store, pairs a device, generates the project with that address and token, runs the tests, and exports the screenshots the journeys attached. Copy the xcodegen output path from `apps/apple/DerivedData` when opening the project in Xcode.

Every lane runs `bun run native:format` first, which checks every tracked Swift file with the Xcode toolchain's swift-format against `apps/apple/.swift-format`. swift-format ships with Xcode, so the native style gate needs no install. The check writes nothing; to fix drift, run `xcrun swift-format format --in-place` on the changed files.

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
