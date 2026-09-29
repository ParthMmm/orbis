# Orbis web client (Cloudflare)

The web client at `https://orbis.p11a.xyz`, built with TanStack Start and shadcn (preset `b3loz15fu`) and deployed to Cloudflare Workers with Alchemy 2 ([ADR 0015](../../docs/adr/0015-web-on-cloudflare-workers.md)). It replaces `apps/web` at the cut-over.

The API, the database, and audio stay on Vanta. The page calls the API at the address in `alchemy.run.ts` (`ORBIS_API_URL`) with the Person's own key, and plays audio from Vanta through stream grants. The Worker never sees a key.

## Sign in to Cloudflare

Alchemy uses the OAuth profile in `~/.alchemy/profiles.json`. The deploy needs Workers scripts, Workers routes, and Zone/DNS access to `p11a.xyz`:

```sh
bun alchemy profile refresh --profile default --provider Cloudflare
```

## Deploy

```sh
cd apps/web-next
bun run deploy     # alchemy deploy --stage prod
```

Alchemy builds with Vite, uploads one Worker with its static assets, and attaches `orbis.p11a.xyz`. Deploy state lives on Cloudflare (`Cloudflare.state()`), so any machine with the profile deploys the same stack. `bun alchemy deploy --stage prod --dry-run` shows the plan without applying it.

## Destroy

```sh
bun run destroy    # alchemy destroy --stage prod
```

This removes the Worker and the custom domain. The API on Vanta is not part of this stack.

## Develop

```sh
ORBIS_API_URL=https://vanta.tail01d084.ts.net:10000/api bun run dev
```

The API allows browser requests from `http://localhost` and `http://127.0.0.1` only when the server runs with development origins enabled. Against the Funnel, test the deployed page.

## Security headers

`src/start.ts` sets a Content Security Policy on every response. Scripts must come from the page's own origin or carry the request's nonce. The page may connect only to itself and the API, and may play media only from the API's origin.
