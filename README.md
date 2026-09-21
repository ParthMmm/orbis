# Orbis

A personal library for YouTube and SoundCloud music and DJ sets.

The first slice saves links and titles, supports title and tag editing, deletion, ordered playlists, tag suggestions, and combined text, source, and tag filters. SQLite keeps the library across server restarts. Click a title to open the original source in your browser.

## Workspace

- `apps/desktop`: Electron Forge + Vite + React desktop app.
- `apps/server`: Bun + Effect v4 RC HTTP API and Bun SQLite storage.
- `packages/contracts`: shared TypeScript API types.
- `apps/apple/OrbisDesign`: SwiftUI design system (tokens, styles, components) shared by the planned macOS and iOS apps. See [ADR 0001](docs/adr/0001-client-platform-strategy.md).
- `apps/raycast`: Save Current Tab and Save Clipboard commands. See [setup and browser support](apps/raycast/README.md).
- `apps/apple/Orbis`: one SwiftUI multiplatform app for iOS and macOS, generated with xcodegen. It imports `OrbisDesign`.

## Development

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

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Health status |
| POST | `/sets` | Save `{ url, title, tags }` |
| GET | `/sets` | List newest first; optional `q`, `source`, `playlistId`, repeated `tag` parameters |
| PATCH | `/sets/:id/title` | Replace title with `{ title }` |
| PATCH | `/sets/:id/tags` | Replace tags with `{ tags }` |
| DELETE | `/sets/:id` | Delete a Set and related membership |
| GET | `/tags` | Existing tags for suggestions |
| GET / POST | `/playlists` | List playlists or create one with `{ name }` |
| PUT | `/playlists/:id/sets` | Replace ordered membership with `{ setIds }` |

Tags are trimmed, lowercased, and deduplicated; each set accepts up to 20 tags of 40 characters. Tag filters use AND semantics. Text search checks titles and URLs. Duplicate normalized links return 409; invalid input returns 400. Metadata is entered manually; short SoundCloud share links and private track links are not supported yet.

Playlists contain whole sets, not individual tracks. A set can belong to multiple playlists; removing membership keeps the library entry. Each playlist supports up to 500 unique sets. Library views sort newest first; playlist views keep playlist order. Folders are deferred.

The desktop uses shadcn preset `b1VlIttI`, Tailwind v4, and the Inter variable font. Layout styles are separate from the generated theme tokens.

Design tokens live in `docs/design/tokens.json`. `node scripts/design-tokens.mjs` regenerates the Swift colors in `OrbisDesign` and `docs/design/tokens.css`.

## Native clients

`apps/apple/Orbis` builds one SwiftUI app for iOS and macOS from an xcodegen specification. The generated project and derived data are not tracked.

```sh
bun run native:lanes          # unit tests and native journeys against a temporary service
bun run native:lanes --unit   # unit tests only
```

A lane starts a temporary Orbis service with its own database and trust store, pairs a device, generates the project with that address and token, runs the tests, and exports the screenshots the journeys attached. Copy the xcodegen output path from `apps/apple/DerivedData` when opening the project in Xcode.

Every lane runs `bun run native:format` first, which checks every tracked Swift file with the Xcode toolchain's swift-format against `apps/apple/.swift-format`. swift-format ships with Xcode, so the native style gate needs no install. The check writes nothing; to fix drift, run `xcrun swift-format format --in-place` on the changed files.

## Security and next steps

**Local-only by default.** The server binds to loopback. A request carrying a browser `Origin` header is refused, a request from a non-loopback host is refused unless it carries a valid device token, and loopback requests need no credential, which is what the desktop client relies on. Device tokens are enrolled with `bun run --filter @orbis/server trust add --label "<name>"` and the host stores only their digest, so a copy of the trust store cannot authenticate. See `docs/adr/0004-native-service-identity.md`.

Vanta runs the API as a systemd user service behind a tailnet-only Tailscale Serve bridge, so nothing is published publicly. Setup and rollback are in `deploy/orbis-server/README.md`.

The renderer is sandboxed and uses a narrow preload API. Only the main process performs local HTTP requests and opens allowlisted source URLs.

Downloads, playback, retention, shared groups, Tailscale device sharing, iOS, Versos, and MCP remain planned. Raycast capture is implemented; full live and performance verification remains tracked in [Save Sets through Raycast](https://github.com/ParthMmm/orbis/issues/9). See [the first-slice scope](docs/specs/first-library-slice.md). Specs and tickets belong in [GitHub Issues](https://github.com/ParthMmm/orbis/issues).
