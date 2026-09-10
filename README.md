# Sets

A self-hosted library for YouTube and SoundCloud music and DJ sets.

## Workspace

- `apps/desktop`: Electron Forge + Vite + React desktop shell.
- `apps/server`: Fastify API running on Node.js.
- `apps/raycast`: reserved extension workspace, not implemented.
- `apps/ios`: reserved app directory; framework undecided.
- `packages/contracts`: shared API types.

## Development

Requires Node.js 24 and Bun 1.4.1. Bun manages packages; the API runs on Node.js.

```sh
bun install
bun run build --filter=@sets/contracts
bun run dev
```

The API binds to loopback at `http://127.0.0.1:4310/health`. Desktop development opens Electron. To run only the API: `bun run --filter @sets/server dev`.

```sh
bun run typecheck
bun run test
bun run build
bun run format:check
```

Desktop builds package the current host platform into `apps/desktop/out/`; signing, installers, and cross-platform release automation are not configured.

## Scope

This is a scaffold, not a working library. SQLite persistence, downloads, playback, tags, filters, group permissions, Tailscale identity, and optional Versos integration remain to implement. The current API exposes only health and is not ready for remote use. Never expose future private endpoints before identity and authorization are implemented.

The planned deployment uses Tailscale device sharing, keeping friends outside the owner’s personal tailnet. Server and device downloads will have independent retention rules.
