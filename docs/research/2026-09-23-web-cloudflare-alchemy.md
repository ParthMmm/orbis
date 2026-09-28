# Orbis: web + Cloudflare/Alchemy instead of Tailscale (research)

Sources: ADR 0001, 0002, 0004; deploy/orbis-server/README.md; CONTEXT.md; Cloudflare Tunnel docs; Alchemy Tunnel docs (alchemy.run).

## Ask

Private web app shareable with known people via API keys. Replace Tailscale with Cloudflare/Alchemy. Vanta keeps download + storage. Tunnel?

## Current boundary (must not silently break)

- Vanta: systemd user service, loopback only.
- 4310 local (Electron, no token); 4311 device (Bearer digest tokens).
- Tailscale Serve → 4311 only (tailnet, not Funnel/public).
- ADR 0004: any browser `Origin` → 403. Browser must never reach library.
- ADR 0001 deferred: Electron→web, Cloudflare, Alchemy, object storage.
- ADR 0002: download jobs SQLite + Effect worker on Vanta; media on Vanta.

## Recommendation (thin edge)

Keep the Bun/Effect/SQLite/download worker on Vanta. Replace Serve with Cloudflare Tunnel (`cloudflared` outbound to edge → `http://127.0.0.1:4311`). Alchemy owns: Tunnel + Configuration + DNS, and a Worker/Vite SPA for the web UI. Do not run downloads or SQLite on Workers.

Auth for friends: app-level Bearer API keys (same digest-store pattern as device tokens; label as person). Optional Cloudflare Access in front is defense-in-depth, not the friend credential.

Web requires superseding ADR 0004 Origin ban with an exact Origin allowlist + CORS for the SPA hostname only. Unknown Origins still 403. Never route tunnel at 4310.

## Rejected / deferred

- Moving library or download orchestration to Workers/D1 now.
- Cloudflare Access service tokens as the only friend credential (CF account / Access UX tax).
- Exposing token-free local listener.
- R2 for retained audio in slice 1 (good later for streaming off Vanta bandwidth).

## Open decisions (grill)

1. Shared single Library vs per-friend isolation.
2. Domain for SPA + API.
3. Keep Tailscale for native/self while friends use CF web?
