<p align="center">
  <img src="docs/images/icon.png" alt="The Orbis icon: a dark orb with a blue and coral edge" width="128">
</p>

<h1 align="center">Orbis</h1>

<p align="center">
  <a href="https://github.com/ParthMmm/orbis/actions/workflows/quality.yml"><img src="https://github.com/ParthMmm/orbis/actions/workflows/quality.yml/badge.svg" alt="Code quality"></a>
</p>

A private library for long music: DJ sets and mixes from YouTube and SoundCloud. Paste a link, file it with a title and tags, download the audio to a server you own, and play it from a native iPhone, iPad, or Mac app.

<p align="center">
  <img src="docs/images/library.png" alt="The Orbis library on iPhone: a paste field above a list of filed sets" width="320">
</p>

Orbis is a personal project for a private Group of listeners. The API and library data live on Cloudflare; an audio node on Vanta retains and serves the audio. The source is public to read and to fork. It is not open source; see [License](#license).

## How it fits together

```text
 iPhone / iPad / Mac ─┐
 Raycast / web ────────┴── HTTPS + Person key ──▶ Cloudflare API + SQLite Group
                                                        │
                                              Vanta opens WebSocket
                                                        │
                                              Vanta audio node
                                              yt-dlp / Cobalt + files
```

The Group owns library data, People, keys, and Download scheduling. Vanta connects to it to fetch Downloads and serves Retained Audio through signed stream grants. Older API addresses forward to the Group during the transition. See [ADR 0018](docs/adr/0018-api-on-a-durable-object.md).

Saving a link creates a Person's Library Entry. Auto Download starts a Download when enabled. Each Person has a Listening Queue and Playback Positions shared across their devices. [CONTEXT.md](CONTEXT.md) defines these terms.

## What is in the repo

| Path | What it is |
| --- | --- |
| [`apps/server`](apps/server) | Shared Effect HTTP handlers, local Bun API adapter, and production audio node |
| [`apps/api`](apps/api) | Cloudflare API Worker and SQLite Group Durable Object |
| [`apps/web`](apps/web) | TanStack Start web client and Alchemy deployment for web and API |
| [`apps/apple/Orbis`](apps/apple/Orbis) | One SwiftUI app for iOS and macOS, with Now Playing, CarPlay, and a share extension. The Xcode project is generated with xcodegen |
| [`apps/apple/OrbisDesign`](apps/apple/OrbisDesign) | Swift package with the design tokens, styles, and components |
| [`apps/raycast`](apps/raycast) | Raycast commands: Save Current Tab and Save Clipboard |
| [`apps/desktop`](apps/desktop) | Legacy Electron, Vite, and React client. Retirement is tracked in GitHub Issues |
| [`packages/contracts`](packages/contracts) | Typed HTTP contract, derived client, and audio-node protocol |
| [`deploy`](deploy) | Vanta operation and rollback guides, systemd templates, and Cobalt Compose file |

## Choices worth a look

- **Domain language first.** [`CONTEXT.md`](CONTEXT.md) defines the terms (Set, Retained Audio, Playback Position, Listen) and the words to avoid. The code and the [decision records](docs/adr) use them.
- **Decision records.** [ADRs](docs/adr) record platform, storage, identity, and deployment decisions. Implementation and live acceptance evidence belong in [GitHub Issues](https://github.com/ParthMmm/orbis/issues).
- **One source for design tokens.** [`docs/design/tokens.json`](docs/design/tokens.json) generates the Swift colors and the CSS. CI fails if the output drifts.
- **Native test lanes.** `bun run native:lanes` starts a temporary server with its own database and trust store, pairs a device, and runs the unit tests and UI journeys against it. See [development](docs/development.md#native-clients) for lane modes and evidence retention.
- **Swift 6 strict concurrency**, on by default in the app target.
- **Written for agents too.** [`AGENTS.md`](AGENTS.md) and [`docs/agents`](docs/agents) record how coding agents work in this repo: issue tracker, triage labels, and how to verify UI on a real build.

## Status

Implementation status and remaining production checks live in [GitHub Issues](https://github.com/ParthMmm/orbis/issues).

Signing, notarization, and App Store release are not set up. The native app is built and run from Xcode.

## Run it

You need Bun 1.4.1 and Node.js 24. The native app also needs Xcode 26.

```sh
bun install
bun run dev          # local workspace development tasks
bun run check        # lint, format, types, tests, Effect diagnostics
```

Setup, server logging, the smoke test, and the native lanes are in [`docs/development.md`](docs/development.md). Routes are in [`docs/api.md`](docs/api.md). Cloudflare deployment is in [`apps/api/README.md`](apps/api/README.md). Operating the Vanta audio node is in [`deploy/orbis-server`](deploy/orbis-server/README.md).

Download backends use yt-dlp and a self-hosted [Cobalt](https://github.com/imputnet/cobalt) instance. See [`deploy/cobalt`](deploy/cobalt) and [`docs/research/cobalt-self-hosting.md`](docs/research/cobalt-self-hosting.md). Use it only for content you have the right to save.

## Contributing

I do not take pull requests or feature requests. Issues here are my own planning notes. Forks are welcome.

## License

Copyright (c) 2026 Parth Mangrola. All rights reserved. You can read the code and fork it on GitHub. You need written permission to reuse it. See [`LICENSE`](LICENSE).
