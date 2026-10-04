# Orbis web client (Cloudflare)

The web client at `https://orbis.p11a.xyz`, built with TanStack Start and shadcn (preset `b3loz15fu`) and deployed to Cloudflare Workers with Alchemy 2 ([ADR 0015](../../docs/adr/0015-web-on-cloudflare-workers.md)).

The application API, the active database, and audio stay on Vanta during the Group foundation rollout. The same Alchemy stack also deploys the [API Worker and Group](../api/README.md), which currently serve only `/api/health`. The page calls the API at the address in `alchemy.run.ts` (`ORBIS_API_URL`) with the Person's own key, and plays audio from Vanta through stream grants. The Worker never sees a key.

## Sign in to Cloudflare

Alchemy uses the OAuth profile in `~/.alchemy/profiles.json`. The deploy needs Workers scripts, Workers routes, and Zone/DNS access to `p11a.xyz`:

```sh
./node_modules/.bin/alchemy profile edit --profile default --add Cloudflare
```

## Deploy

```sh
cd apps/web
bun run deploy     # alchemy deploy --stage prod
```

Alchemy builds with Vite, uploads the web Worker with its static assets and the API Worker with its SQLite Group, and attaches `orbis.p11a.xyz`. Deploy state lives on Cloudflare (`Cloudflare.state()`), so any machine with the profile deploys the same stack. `bun alchemy deploy --stage prod --dry-run` shows the plan without applying it.

## Destroy

```sh
bun run destroy    # alchemy destroy --stage prod
```

This removes both Workers, the custom domain, the `/api/*` route, and the Group namespace with its stored data. The active API on Vanta is not part of this stack. Export Group data before destroying a stack once the API migration has cut over.

## Develop

```sh
ORBIS_API_URL=https://vanta.tail01d084.ts.net:10000/api bun run dev
```

The API allows browser requests from `http://localhost` and `http://127.0.0.1` only when the server runs with development origins enabled. Against the Funnel, test the deployed page.

## Devices on the tailnet

On a device running Tailscale, MagicDNS resolves the Funnel name to Vanta's tailnet address (`100.77.187.21`). Chrome treats that as a local address and blocks a public site from calling it until the Person allows it: Chrome's Local Network Access prompt ("wants to access devices on your local network") appears on the first API call, once per site. A device without Tailscale resolves the public Funnel relay and sees no prompt. Safari does not have the rule. Checked on 2026-09-29 with Playwright's Chromium: denied, the request fails; granted, or resolved to the public relay, the API answers.

## Security headers

`src/start.ts` sets a Content Security Policy on every response. Scripts must come from the page's own origin or carry the request's nonce. The page may connect only to itself and the API, and may play media only from the API's origin.

## Verify the migration

Run from the repository root after a frozen install:

```sh
	bun run --filter @orbis/contracts build
	bun run --filter @orbis/web test
	bun test apps/server/src
```

The web test command builds the production client, then runs nine journeys once each against real HTTP listeners and a temporary SQLite database. Only the external audio provider uses the retained-audio fixture. Each journey exports screenshots and `result.json` under the root `.cache` directory. It leaves the production service and database untouched.

The four original journey groups keep their entrypoint names. Their assertions now use the rebuilt client:

| Original group | Runnable suite | Verified behavior | Artifact directory |
| --- | --- | --- | --- |
| `journey` | `e2e/journey.mjs`, `e2e/sign-in.mjs`, `e2e/playlists.mjs`, `e2e/live-queue.mjs` | Key sign-in and revocation, Library saves, search, Tags, Downloads, Auto Download in both directions, Collaborative Playlists, player grants and audio retry | `.cache/web-library`, `.cache/web-sign-in`, `.cache/web-playlists`, `.cache/web-player` |
| `admin-journey` | `e2e/admin-journey.mjs` | Admin scope rejection, People, key minting and copying, revocation, removal, and session-only admin credentials | `.cache/web-admin` |
| `live-queue` | `e2e/live-queue.mjs` | Remote Playlist enqueue, another Person's queue isolation, bearer-authenticated events, reconnect, Playback Position, and automatic advance | `.cache/web-player` |
| `shared-audio` | `e2e/shared-audio.mjs` | Shared playback without saving, the caller's Playback Position, a save without the friend's title, and a shared Download that plays | `.cache/web-social` |

The migration spec [#137](https://github.com/ParthMmm/orbis/issues/137) has thirteen child issues. The table records the code verification for each child. A passing local journey does not verify a live deployment.

| Child | Verification |
| --- | --- |
| [#138](https://github.com/ParthMmm/orbis/issues/138), Cloudflare scaffold | Production build and Alchemy production dry-run. Stack `OrbisWeb`, resource `Web`, stage `prod`, and domain `orbis.p11a.xyz` keep their identity after the directory rename. |
| [#139](https://github.com/ParthMmm/orbis/issues/139), web Origin | `apps/server/src/web-ingress.test.ts` accepts the Cloudflare Origin and refuses the old Funnel Origin and every Origin on the local listener. |
| [#140](https://github.com/ParthMmm/orbis/issues/140), key sign-in | `e2e/sign-in.mjs`, `.cache/web-sign-in`. |
| [#141](https://github.com/ParthMmm/orbis/issues/141), admin | `e2e/admin-journey.mjs`, `.cache/web-admin`. |
| [#142](https://github.com/ParthMmm/orbis/issues/142), Invites | `e2e/invite.mjs`, `.cache/web-invite`, and server Invite HTTP tests. |
| [#143](https://github.com/ParthMmm/orbis/issues/143), Device Link | `e2e/device-link.mjs`, `.cache/web-device-link`, and server Device Link HTTP tests. |
| [#144](https://github.com/ParthMmm/orbis/issues/144), Devices | `e2e/devices.mjs`, `.cache/web-devices`, and server key HTTP tests. |
| [#145](https://github.com/ParthMmm/orbis/issues/145), Library | `e2e/journey.mjs`, `.cache/web-library`. |
| [#146](https://github.com/ParthMmm/orbis/issues/146), player and queue | `e2e/live-queue.mjs`, `.cache/web-player`. |
| [#147](https://github.com/ParthMmm/orbis/issues/147), Playlists | `e2e/playlists.mjs`, `.cache/web-playlists`, and server Collaborative HTTP tests. Deploy the matching API before the new Playlist client. |
| [#148](https://github.com/ParthMmm/orbis/issues/148), Social | `e2e/shared-audio.mjs`, `.cache/web-social`. |
| [#149](https://github.com/ParthMmm/orbis/issues/149), Apple Device Link | Separate Apple change. Run `node scripts/native-lanes.mjs --journeys` on that branch. This cutover does not verify an Apple build. |
| [#150](https://github.com/ParthMmm/orbis/issues/150), cutover | Four original browser groups above and old-Origin HTTP rejection. Follow the [live cutover procedure](../../deploy/orbis-server/README.md#cut-over-to-cloudflare-and-an-api-only-funnel). |

Live rollout not performed by this repository change. The production dry-run reads the existing Cloudflare deployment without applying changes. Record the approved Vanta update, handler removal, live browser playback, and status output separately before closing the cutover issue.
