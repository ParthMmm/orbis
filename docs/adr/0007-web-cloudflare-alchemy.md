# Expose Orbis on the web through Cloudflare Tunnel and Alchemy

Orbis gains a private web client at `https://orbis.p11a.xyz` talking to `https://api.orbis.p11a.xyz`. The Bun/Effect/SQLite service, download worker, and retained audio stay on Vanta. Cloudflare Tunnel (`cloudflared` outbound) replaces Tailscale Serve as the path from the public DNS names to the device listener on `127.0.0.1:4311`. Alchemy owns the TypeScript declaration of DNS, the tunnel ingress, and the SPA (Worker/assets). It does not replace the Bun server.

Browser clients are allowed only from the SPA origin `https://orbis.p11a.xyz`. The server allowlists that Origin (and local dev origins as needed) and answers CORS for it; any other Origin stays 403. This supersedes the blanket Origin refusal in ADR 0004 for the web path only. Electron on the local listener (`4310`) stays token-free and must never be the tunnel target.

Tailscale may remain for operator access; it is no longer required for friend access. Cloudflare Access is optional defense-in-depth and is not the friend credential.

Rejected alternatives:

- **Move the library server onto Workers/D1.** Wrong runtime for Cobalt, sequential download jobs, and local retained audio.
- **R2 for audio in the first web slice.** Useful later so friends do not pull audio through Vanta's uplink; not required to ship the web edge.
- **Cloudflare Access or service tokens as the only friend login.** Wrong UX for "here is a key, open the site."
- **Tunnel to 4310.** Would restore a token-free path from the internet.

This picks up the Electron-to-web / Cloudflare / Alchemy deferral in ADR 0001 for the web path only. Native clients may keep using Tailscale or the same API hostnames with the same keys (ADR 0008).
