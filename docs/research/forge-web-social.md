# Handoff: Orbis web + social (for forge)

**Repo:** https://github.com/ParthMmm/orbis  
**From:** atlas (research/architecture)  
**Do not:** atlas does not implement; this is the fence for implementation.

## Goal

Private web app at `orbis.p11a.xyz` → API `api.orbis.p11a.xyz` via Cloudflare Tunnel + Alchemy; Vanta keeps downloads + retained audio; multi-person private group with API keys; social overlay; collaborative playlists.

## Digests in this repo

Landed in this repo (glossary into `CONTEXT.md` when implementing):

- [`../adr/0007-web-cloudflare-alchemy.md`](../adr/0007-web-cloudflare-alchemy.md)
- [`../adr/0008-people-and-api-keys.md`](../adr/0008-people-and-api-keys.md)
- [`../adr/0009-social-visibility.md`](../adr/0009-social-visibility.md)
- [`../adr/0010-shared-audio-and-collab-playlists.md`](../adr/0010-shared-audio-and-collab-playlists.md)
- [`glossary-social-delta.md`](glossary-social-delta.md)

Supersedes / evolves: ADR 0001 (web/CF/Alchemy no longer deferred for this path), ADR 0004 (Origin allowlist + Person keys).

## Suggested skills

- `implement` (after tickets)
- `to-tickets` or `to-spec` if you want tracer bullets first
- `domain-modeling` when updating CONTEXT.md
- Cloudflare plugin skills / Alchemy docs when wiring tunnel + SPA
- `tdd` for authz (see/appear/social) and Origin allowlist

## Slice order (suggested)

1. Person + key store (evolve devices.json) + Origin allowlist + CORS for `https://orbis.p11a.xyz`
2. Alchemy: tunnel → `127.0.0.1:4311`, DNS for `orbis` + `api.orbis` on `p11a.xyz`, SPA shell
3. Canonical Set / shared retained audio + library membership migration
4. Social master + see/appear + presence/history read APIs
5. Collaborative playlist flag + editors
6. Web UI: paste key, username, social toggles, friend libraries, player streaming API audio

## Out of fence

R2 audio, Cloudflare Access as login, multi-group, public signup, Orbis-sent iMessage/email for keys, one-time claim URLs.

## Key sharing (ops)

Host mints key → plaintext shown once → host sends out of band (iMessage ok) → friend pastes into client. Prefer they save in a password manager. Never put key in URL query.
