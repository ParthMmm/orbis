# Expose Orbis on the web through Tailscale Funnel

Orbis gains a private web client that friends open with a link and nothing installed. The Bun/Effect/SQLite service, download worker, and Retained Audio stay on Vanta. Tailscale Funnel on port 10000 makes one address public, `https://vanta.tail01d084.ts.net:10000`, and Tailscale Serve routes it: `/api` to the device listener on `127.0.0.1:4311`, and `/` to the web client's built files. Funnel accepts only ports 443, 8443, and 10000; Caddy holds 443 and Jellyfin's Funnel holds 8443.

The web client lives in `apps/web`, a Vite React SPA that starts from the desktop renderer in `apps/desktop/src`. The Electron app keeps working on the local listener until the web client reaches parity; retiring it is a later decision.

The SPA and the API share one origin, so the browser needs no CORS. Browsers still send an `Origin` header on writes, so the device listener allowlists the Funnel origin (and local dev origins in development only). Any other Origin stays 403. This supersedes the blanket Origin refusal in ADR 0004 for the device listener only. The local listener (`4310`) still refuses every Origin and is never the Funnel target.

An `<audio>` element cannot send an `Authorization` header, and ADR 0008 forbids API keys in URLs. The web player therefore asks for a stream grant: an authenticated `POST /sets/:id/audio/grant` returns a URL to that Set's audio route with an HMAC signature over the Set, the Person, and an expiry 24 hours out. The audio route accepts either a Bearer key or a valid grant; no other route accepts a grant. The request log already drops the query string, so grants do not reach logs. A leaked grant exposes one Set's audio for at most one day, and cannot read or change anything.

Funnel relays encrypted TCP; the certificate and TLS end on Vanta, so Tailscale carries the audio without being able to read it and stores nothing. Orbis needs no router port forward, and Vanta's home address stays private. The address is public, so the device listener limits failed key attempts.

Native clients move to the Funnel address too, so every client and every friend uses one address. The tailnet-only Serve rule on port 8444, which native clients use to reach the device listener today, stays until they have moved and is then removed.

Vanta's exposure was checked on 2026-09-27, before this change. Jellyfin's Funnel on 8443 was the only public service. On its home network address Vanta listened only for SSH, SMB, and a gitea-runner, and had no forwarding rule for internet traffic. From outside, the home IP answered on none of the ports tested over IPv4 or IPv6. A connection to port 443 appeared to succeed, but the mobile carrier used for the test accepts port 443 for any address, including unused ones. An eero port forward left from earlier Jellyfin access reaches nothing, because Jellyfin publishes only on the tailnet and loopback. After this change the Orbis Funnel on 10000 is the second public service.

Rejected alternatives:

- **Cloudflare Tunnel and Alchemy.** Cloudflare decrypts traffic at its edge, and its terms restrict large media through its proxy on non-Enterprise plans.
- **Store Retained Audio in R2 or any third party.** Makes another company the host of stored copies of audio taken from YouTube and SoundCloud.
- **Share Vanta with each friend over Tailscale.** Every friend installs and signs in to Tailscale.
- **Port forward on the eero to a separate public Caddy.** Fastest and allows `orbis.p11a.xyz`, but opens a router port, exposes the home address, and adds a second Caddy, dynamic DNS, a DNS-challenge certificate, and a host firewall to maintain. It is the upgrade path if Funnel's throughput proves too low; clients change only their saved address.
- **ngrok.** Its free tier's transfer cap is too small for audio, and it decrypts traffic by default.
- **Funnel to 4310.** Would restore a token-free path from the internet.
- **A session cookie for audio.** Adds a second credential kind with its own lifetime and CSRF surface. A grant touches one route.
- **Fetch audio into a blob.** Loads a whole DJ set into memory before playback and breaks seeking.

The trade this accepts is Tailscale's unpublished Funnel bandwidth limit and relay latency, an address on `ts.net` instead of `p11a.xyz`, and no free Funnel port left for anything else. One Set streams at about 130 kbps, so a limit should show first as slower starts and seeks, not dropouts.

This picks up the Electron-to-web deferral in ADR 0001. Cloudflare, Alchemy, and object storage stay deferred.
