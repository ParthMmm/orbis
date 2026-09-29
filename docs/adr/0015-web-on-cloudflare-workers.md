# Serve the web client from Cloudflare Workers and keep the API and audio on Vanta

The web client moves from the Funnel to Cloudflare Workers at `https://orbis.p11a.xyz`. It is rebuilt with TanStack Start and TanStack Router, and its components come from shadcn with the `b3loz15fu` preset (the `base-luma` style on Base UI, Phosphor icons, mauve). Alchemy 2 deploys it from `apps/web` as one `Cloudflare.Website.Vite` Worker that serves the rendered pages and the static assets, and attaches the custom domain. Alchemy signs in to Cloudflare through its OAuth profile, so no API token is stored in the repository.

The API, the database, the download worker, and Retained Audio stay on Vanta behind the Funnel address from ADR 0007, `https://vanta.tail01d084.ts.net:10000/api`. The browser calls that address directly. The web client and the API are now two origins, so the device listener adds `https://orbis.p11a.xyz` to the browser origins it allows and answers its CORS preflight. Every other Origin still gets 403, and the local listener (`4310`) still refuses every Origin. This supersedes ADR 0007's rule that the web client and the API share one origin.

Cloudflare never carries audio or library data. The player still asks the API for a stream grant (ADR 0007), and the grant URL points at the Funnel, so the `<audio>` element fetches Retained Audio from Vanta. The API key stays in the browser and goes only to the API, as ADR 0008 requires. The Worker never receives a key, so it cannot load a Person's data. It renders the page without data, and each route loads its data in the browser. This answers ADR 0007's objections to Cloudflare: Cloudflare sees the app's code, not its traffic or its media.

The Funnel keeps `/api`. It stops serving the old web client at `/` when the new one reaches parity with it, which includes the four browser journeys in `apps/web/e2e`. Friends then get `https://orbis.p11a.xyz` as the link.

Alchemy 2 needs `effect` 4.0.0-rc.115 or later, so the workspace moved to rc.117 first. Effect rc.118 moves every `effect/unstable/*` module to the root, and Alchemy 2.0.0-beta.79 still imports the old paths, so Effect stays on rc.117 until an Alchemy release follows.

This is the first of two steps. The next ADR moves the API to Cloudflare Workers with D1 and leaves the Funnel serving only audio. This decision already fits that shape: the browser calls the API cross-origin with its own key and fetches audio from Vanta with a grant, so only the API's address changes.

Rejected alternatives:

- **The Worker proxies the API with server functions.** Allows server-rendered library pages, but the key would move into a cookie the Worker reads, and Cloudflare would see every key and response. A session cookie is the second credential kind ADR 0007 rejected.
- **Keep serving the web client from the Funnel.** Needs no new origin, but keeps the `ts.net` address, ties every web deploy to Vanta, and leaves the next step, the API on Workers, with no web app already on Cloudflare.
- **Wrangler.** Cloudflare's own tool and well documented for TanStack Start, but the configuration would be a second language beside the Effect code, and the API move needs D1, Durable Objects, and custom domains in the same program. Alchemy keeps all of it in TypeScript.
- **Cloudflare Pages.** Cloudflare now points framework apps at Workers with static assets, and TanStack Start deploys to Workers.
- **Move the API to Workers and D1 in the same change.** Rewrites the web client, the storage layer, and the download worker's job handoff at once, and leaves nothing working in between.

The trade this accepts is a CORS preflight before each write, Cloudflare as a dependency of the web client, and pre-release tools: Alchemy 2 is in beta and ties the workspace to a specific Effect release candidate. When Cloudflare is down, the web client is down, and the native clients and Raycast keep working against the Funnel.
