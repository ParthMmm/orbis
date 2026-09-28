# Orbis web and social plan

This plan turns the single-owner service into a private Group with a web client. The decisions are ADRs 0007 through 0010 and 0013. Vanta keeps the library server, download worker, and Retained Audio; Cloudflare Tunnel and an Alchemy-managed SPA add the web edge.

## Order

Each step ships and is verified before the next starts. Steps 1 and 2 must land before the Host mints the first friend key, because anything a friend writes before the split cannot be attributed.

1. **People and keys** (ADR 0008). Add `people` to the trust store and `personId` to key records. Migrate existing devices to the Host Person. Resolve every device-listener request to a Person; local-listener requests act as the Host. Extend `bun run trust` with `person add`, `key add`, `key revoke`, and `person remove`.
2. **Per-Person state** (ADR 0013). Split `sets` into Set and Library Entry. Key Playback Position, Listening Queue, and Playlists by Person. Migrate existing rows to the Host. Every existing route keeps its shape and acts as the caller.
3. **Listens** (ADR 0009). Add the `listens` table, write a row per Listen, and derive the counters from it.
4. **Web ingress** (ADR 0007). Origin allowlist and CORS on the device listener only; stream grants on `/sets/:id/audio`. Alchemy declares the tunnel to `127.0.0.1:4311`, DNS for `orbis` and `api.orbis` on `p11a.xyz`, and the SPA Worker.
5. **Web client.** `apps/web` from the desktop renderer: key entry, username, Library, Playlists, Listening Queue, and playback through stream grants.
6. **Social** (ADR 0009). Social switch, see and appear filters, the visibility gate, `GET /people`, `GET /people/:username/sets`, `/playlists`, `/presence`, and `/listens`.
7. **Shared audio** (ADR 0010). Download and play any visible Set; delete Retained Audio only when nothing refers to it.
8. **Collaborative Playlists** (ADR 0010). Collaborative flag and editors.

Native clients need no change until step 6 beyond accepting the same key. Their social views follow the web client.

## API changes

| Change | Step |
| --- | --- |
| Every device-listener route acts as the key's Person | 1 |
| `GET /me`, `PATCH /me` (username, Social switch) | 1, 6 |
| Library, queue, position, tag, and title routes read and write the caller's state | 2 |
| `POST /sets/:id/audio/grant`; `/sets/:id/audio` accepts a grant | 4 |
| `GET /people`, `PUT /people/:username/filters` (see, appear) | 6 |
| `GET /people/:username/sets`, `/playlists`, `/presence`, `/listens` | 6 |
| `PUT /playlists/:id/collaborative`, `PUT` and `DELETE /playlists/:id/editors/:username` | 8 |

Host commands stay on Vanta's command line. No admin route exists.

## Verification

- Visibility gate: table tests over Social, see, appear, and removal for both People.
- Origin: the device listener accepts only the SPA Origin; the local listener refuses every Origin.
- Grants: an expired, altered, or other-Set grant gets 401; a grant is refused on every other route.
- Migration: a copy of the live database migrates, and the Host's Library, Playlists, queue, positions, and edited titles read back unchanged.
- Tunnel: from outside the tailnet, `api.orbis.p11a.xyz/health` returns 401 without a key and 200 with one.

## Out of scope

R2 audio, Cloudflare Access as login, more than one Group, public signup, Orbis-sent key delivery, and one-time claim links.
