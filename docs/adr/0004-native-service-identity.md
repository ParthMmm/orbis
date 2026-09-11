# Authenticate native clients with a per-device token the host stores only as a digest

The Orbis service keeps binding to loopback. Native Apple clients reach it through a Tailscale Serve bridge on the tailnet address, so the Host header is no longer loopback and the first slice's local-only rule would reject them.

The server decides in one place, in the `handler` wrapper in `apps/server/src/app.ts`. A request carrying any `Origin` header is refused with 403, because a browser must never reach the library. A request carrying an `Authorization: Bearer` header is refused with 401 unless the token's SHA-256 matches a record in `devices.json`. A request with no such header is accepted when its Host is loopback, which is exactly the rule the Electron client relies on, so the desktop app needs no change. Everything else is refused with 403.

The host stores only `sha256(token)` per device, never the token. A copy of `devices.json` therefore cannot authenticate against the library, and revoking one device is deleting one record, effective on the next request with no restart. Tokens are enrolled with `bun run trust add --label "<name>"`, which prints the token once and writes the store atomically at mode 0600.

Rejected alternatives:

- **A bearer token the host holds in full.** Smaller, and rejected because `ORBIS_DATA_DIR` then contains a working master credential, so one backup, one careless `cat`, or one environment leak grants permanent access to the library from anywhere.
- **Tailnet membership as the credential.** Cannot distinguish a tailnet request that carries a credential from one that does not, which is the row that matters, and it makes every process on every admitted node a full client.
- **Trusting a proxy-injected identity header.** Every admitted tailnet peer gets the header, so it reduces to tailnet membership with an extra step, and it makes the tailnet user rather than the device the principal.
- **Mutual TLS.** `tailscale serve` terminates TLS at the proxy, so a client certificate never reaches the loopback backend, and the loopback bind is a stated constraint.
- **A signed per-request proof from a Secure Enclave key.** Designed in full and rejected as roughly ten times the machinery for one person's two devices. Its decisive insight was kept, which is that the host must not hold a usable secret. What it adds over this design is binding a credential to one request so a captured one cannot be replayed, and that is not worth a canonical string, a clock window, and a key ceremony on a private tailnet behind TLS.
- **A one-time pairing code with an enrolment endpoint.** Reintroduces a shared secret plus a second store with expiry, to save one copy and paste per device.

The trade this accepts is that a captured device token is replayable until it is revoked. Tailscale carries the traffic and TLS protects it in transit, and the tokens are per device, so the blast radius of a leak is one device and one revocation command.
