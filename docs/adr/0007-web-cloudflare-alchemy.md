# Expose Orbis on the web through Cloudflare Tunnel and Alchemy

Orbis gains a private web client at `https://orbis.p11a.xyz` talking to `https://api.orbis.p11a.xyz`. The Bun/Effect/SQLite service, download worker, and Retained Audio stay on Vanta. Cloudflare Tunnel (`cloudflared` outbound) is the path from the public DNS names to the device listener on `127.0.0.1:4311`. Alchemy owns the TypeScript declaration of DNS, the tunnel ingress, and the SPA (Worker static assets). It does not replace the Bun server.

The web client lives in `apps/web`, a Vite React SPA that starts from the desktop renderer in `apps/desktop/src`. The Electron app keeps working on the local listener until the web client reaches parity; retiring it is a later decision.

Browser clients are allowed only from the SPA origin `https://orbis.p11a.xyz`. The server allowlists that Origin (and local dev origins in development only) and answers CORS for it, including preflight for the `Authorization` header with a long `Access-Control-Max-Age`. Any other Origin stays 403. This supersedes the blanket Origin refusal in ADR 0004 for the device listener only. The local listener (`4310`) still refuses every Origin and must never be the tunnel target.

An `<audio>` element cannot send an `Authorization` header, and ADR 0008 forbids API keys in URLs. The web player therefore asks for a stream grant: an authenticated `POST /sets/:id/audio/grant` returns a URL to that Set's audio route with an HMAC signature over the Set, the Person, and an expiry 24 hours out. The audio route accepts either a Bearer key or a valid grant; no other route accepts a grant. The request log already drops the query string, so grants do not reach logs. A leaked grant exposes one Set's audio for at most one day, and cannot read or change anything.

Tailscale Serve may stay for operator access and native clients; friends do not need it. Both ingress paths target 4311 and use the same keys. Cloudflare Access is optional defense in depth and is not the friend credential.

Rejected alternatives:

- **Move the library server onto Workers/D1.** Wrong runtime for Cobalt, sequential download jobs, and local Retained Audio.
- **Store Retained Audio in R2.** Takes load off Vanta's uplink, and makes Cloudflare the host of stored copies of audio taken from YouTube and SoundCloud. Retained Audio stays on Vanta and is never stored with a third party.
- **Cloudflare Access or service tokens as the only friend login.** Wrong experience for "here is a key, open the site."
- **Tunnel to 4310.** Would restore a token-free path from the internet.
- **A session cookie for audio.** `orbis` and `api.orbis` are same-site, so a `SameSite=Strict` cookie would work, but it adds a second credential kind with its own lifetime and CSRF surface. A grant touches one route.
- **Fetch audio into a blob.** Loads a whole DJ set into memory before playback and breaks seeking.
- **Serve the API from the SPA origin through a Worker proxy.** Removes CORS, and puts every audio byte through a Worker as well as the tunnel.

The trade this accepts is that every friend's audio stream crosses Cloudflare's network and Vanta's uplink. Cloudflare's terms restrict serving large media through its proxy on non-Enterprise plans, and DJ sets are hundreds of megabytes. For a handful of people this is expected to go unnoticed; if Cloudflare objects, audio leaves Cloudflare instead of moving deeper into it. Grants then point at Vanta's tailnet address, served by Tailscale Serve on a port other than 443, and each friend installs Tailscale and accepts Vanta as a shared node. The API and the SPA stay on Cloudflare, and a browser's `<audio>` element loads a cross-origin source without CORS, so nothing else changes.

This picks up the Electron-to-web, Cloudflare, and Alchemy deferral in ADR 0001 for the web path only.
