# Orbis web and social plan

Historical plan. This records the original build sequence, paths, and verification tools. Use [development](../development.md) for current source ownership and verification, [ADR 0018](../adr/0018-api-on-a-durable-object.md) for the current deployment decision, and [GitHub Issues](https://github.com/ParthMmm/orbis/issues) for remaining acceptance checks.

This plan turns the single-owner service into a private Group with a web client. The decisions are ADRs 0007 through 0010, 0013, and 0014. Vanta keeps the library server, download worker, and Retained Audio; Tailscale Funnel on port 10000 makes the API and the web client public at one address.

## Order

Each step ships and is verified before the next starts. Steps 1 through 4 must land before the Host mints the first friend key: anything a friend writes before the split cannot be attributed, and friends' data needs a backup.

1. **Typed API** (ADR 0014). Move the existing routes into an `HttpApi` in `packages/contracts` with no change in behavior. Web and Raycast switch to the derived client.
2. **People and keys** (ADR 0008). Add `people` to the trust store and `personId`, `scope`, and `lastUsedAt` to key records. Migrate existing devices to the Host Person. Resolve every device-listener request to a Person in the security middleware; local-listener requests act as the Host. Extend `bun run trust` with `person add`, `key add`, `key revoke`, and `person remove`.
3. **Per-Person state** (ADR 0013). Split `sets` into Set and Library Entry. Key Playback Position, Listening Queue, and Playlists by Person. Migrate existing rows to the Host. Every existing route keeps its shape and acts as the caller.
4. **Backups.** A nightly SQLite backup (`VACUUM INTO` or Litestream) off Vanta, with one tested restore. Retained Audio can be downloaded again and is not backed up.
5. **Listens** (ADR 0009). Add the `listens` table, write a row per Listen, and derive the counters from it.
6. **Web ingress** (ADR 0007). Origin allowlist on the device listener only; stream grants on `/sets/:id/audio`; a limit on failed key attempts. Tailscale Serve on 10000 routes `/api` to `127.0.0.1:4311` and `/` to the built web client; Funnel makes 10000 public. Check that Serve strips `/api` before proxying, and that the Swift and Raycast clients accept an address with a path.
7. **Web client.** `apps/web` from the desktop renderer: key entry, username, Library, Playlists, Listening Queue, and playback through stream grants. The admin page ships here too.
8. **Events** (ADR 0014). `GET /events` streams the caller's queue changes, so a Playlist started on the phone shows on the web without a reload.
9. **Social** (ADR 0009). Social switch, see and appear filters, the visibility gate, the People routes, and Presence on the event stream.
10. **Shared audio** (ADR 0010). Download and play any visible Set; fair download scheduling; delete Retained Audio only when nothing refers to it.
11. **Collaborative Playlists** (ADR 0010). Collaborative flag and editors.

Native clients need no change until step 9 beyond accepting the same key. Their social views follow the web client.

## API changes

| Change | Step |
| --- | --- |
| Routes defined once in `packages/contracts`; OpenAPI served at `/openapi.json` | 1 |
| Every device-listener route acts as the key's Person | 2 |
| `GET /me`, `PATCH /me` (username, Social switch) | 2, 9 |
| `/admin/people`, `/admin/people/:personId/keys` (admin scope only) | 2, 7 |
| Library, queue, position, tag, and title routes read and write the caller's state | 3 |
| `POST /sets/:id/audio/grant`; `/sets/:id/audio` accepts a grant | 6 |
| `GET /events` | 8 |
| `GET /people`, `PUT /people/:personId/filters` (see, appear) | 9 |
| `GET /people/:personId/sets`, `/playlists`, `/listens` | 9 |
| `PUT /playlists/:id/collaborative`, `PUT` and `DELETE /playlists/:id/editors/:personId` | 11 |

## Verification

- Visibility gate: table tests over Social, see, appear, and removal for both People.
- Origin: the device listener accepts only the SPA Origin; the local listener refuses every Origin.
- Admin: a key without the admin scope gets 403 on every `/admin` route, including the Host's daily key.
- Grants: an expired, altered, or other-Set grant gets 401; a grant is refused on every other route.
- Migration: a copy of the live database migrates, and the Host's Library, Playlists, queue, positions, and edited titles read back unchanged.
- Backup: restore last night's backup to a scratch directory and start the service against it.
- Funnel: from a phone on cellular, `https://vanta.tail01d084.ts.net:10000/api/health` returns 401 without a key and 200 with one, and a DJ set seeks without stalling.
- Exposure: `tailscale funnel status` lists only 8443 (Jellyfin) and 10000 (Orbis) as public.

## Out of scope

Storing Retained Audio with any third party (R2 included), Cloudflare, a custom domain, more than one Group, public signup, Orbis-sent key delivery, and one-time claim links.
