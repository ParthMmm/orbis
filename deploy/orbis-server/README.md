# Orbis API on Vanta

The API runs as a systemd user service that binds loopback only. Tailscale Serve bridges the tailnet address to that loopback port. No port is published and no Funnel is added.

## Why a user service and a Serve bridge

The server binds `127.0.0.1` only, so nothing on the tailnet or the internet can reach it directly. `tailscale serve` terminates TLS for `vanta.tail01d084.ts.net` and proxies to a loopback port, which gives the native clients a trusted certificate without an App Transport Security exception and without publishing anything.

The service runs two loopback listeners over one database and one trust store:

| Listener | Port | Access rule | Used by |
| --- | --- | --- | --- |
| Local | `ORBIS_PORT` (4310) | No token, and only when the Host is loopback | The Electron main process |
| Device | `ORBIS_DEVICE_PORT` (4311) | An enrolled `Bearer` token on every request | Native clients through Serve |

The listener, not the request Host header, decides whether token-free access is allowed. A tailnet peer cannot present `Host: localhost:4310` to reach the token-free rule, because that traffic arrives on the device listener. Serve must target port 4311. See [Cut over Serve to the device listener](#cut-over-serve-to-the-device-listener).

Native clients authenticate per device. See [`docs/adr/0004-native-service-identity.md`](../../docs/adr/0004-native-service-identity.md).

## Files

| Path | Purpose |
| --- | --- |
| `deploy/orbis-server/orbis-server.service` | The unit, templated on `%h` so it is not tied to one home directory. |
| `~/orbis-service` | A checkout of this repository on the branch being deployed. |
| `~/orbis` | The working checkout. Holds `apps/server/.env.local`, which supplies provider credentials and is ignored by git. |
| `~/orbis-service-data` | `ORBIS_DATA_DIR`. Holds `library.sqlite` and `devices.json`, outside the checkout so a pull cannot touch it. |
| `~/.config/systemd/user/orbis-server.service` | The installed unit. |

## Install or update

```sh
cd ~/orbis-service
git fetch origin && git checkout <branch> && git pull --ff-only
bun install --frozen-lockfile
bun run --filter @orbis/contracts build
mkdir -p ~/.config/systemd/user
cp deploy/orbis-server/orbis-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now orbis-server
systemctl --user status orbis-server --no-pager
```

The service uses `apps/server/src/index.ts` directly, so no server build step is needed. The shared contracts package must be built because the server imports its compiled types.

## Enrol a device

Run this in the checkout with the same `ORBIS_DATA_DIR` the service uses. It prints the token once.

```sh
ORBIS_DATA_DIR=~/orbis-service-data bun apps/server/src/trust.ts add --label "iPhone 17 Pro"
ORBIS_DATA_DIR=~/orbis-service-data bun apps/server/src/trust.ts list
```

Store the token in the client, not in the repository. Revoke one device with `trust.ts remove --id <id>`, which takes effect on the next request without restarting the service.

## Bridge the tailnet address

Serve needs root. Do not run `tailscale set --operator` unless you want that permanently.

```sh
sudo tailscale serve --bg --https=8444 http://127.0.0.1:4311
tailscale serve status
tailscale funnel status
```

The Serve rule must read `tailnet only` and must target the device port 4311. The existing jellyfin Funnel on `8443` must be unchanged.

**Port 443 is not available on this host.** Caddy runs as a container bound directly to the tailnet address on `443`, so `tailscale serve` cannot bind there. The failure is silent. `tailscale serve` prints `Serve started and running in the background`, and then `tailscale serve status` does not list the rule at all, because Tailscale drops a mapping it cannot bind. A client that asks for the bare hostname therefore reaches whatever Caddy is serving and gets that application's HTML, not a connection error and not a 403.

Orbis is therefore served at `https://vanta.tail01d084.ts.net:8444`, and a client must be given that address with the port. Resolving the `443` conflict is the host owner's decision and is not needed for Orbis to work.

## Cut over Serve to the device listener

Deploying this code does not change the Serve target. Code that ships while Serve still points at 4310 does **not** close the suspected bypass, because a tailnet request to the local listener is still token-free. This cutover is an owner action; do not run it as part of a repository change.

1. Confirm the device listener works locally. With `ORBIS_DEVICE_PORT=4311` set, a loopback request to 4311 without a token must return 403, and 4310 must still return 200 for the desktop app.
2. Point only the Orbis Serve rule at the device listener:

```sh
sudo tailscale serve --bg --https=8444 http://127.0.0.1:4311
tailscale serve status
```

3. From a different tailnet node, check the bypass is closed. The external URL and SNI stay the tailnet host; only the Host header is overridden:

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  -H 'Host: localhost:4310' https://vanta.tail01d084.ts.net:8444/health
```

The expected result after cutover is 403, never 200. A normal request with no token must also return 403. An invalid token must return 401. A paired device must return 200; use the existing secret-injection mechanism (`$ORBIS_DEVICE_TOKEN`) and do not echo the token, add it to shell history, or save response payloads. If no safe injection mechanism is available, stop rather than invent one.

If validation fails, disable only the Orbis Serve rule (`sudo tailscale serve --https=8444 off`) instead of pointing it back at 4310. Local access and the stored data stay intact.

## Check from another tailnet machine

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://vanta.tail01d084.ts.net:8444/health
# 403, because there is no device token

curl -s -H "Authorization: Bearer $ORBIS_DEVICE_TOKEN" \
  https://vanta.tail01d084.ts.net:8444/health
# {"status":"ok"}
```

A 401 instead of a 403 means the token is present but not enrolled, so check the label in `trust.ts list`.

## Give the service provider credentials

Metadata enrichment reads a YouTube API key from the environment. The key lives in `apps/server/.env.local` in the working checkout at `~/orbis`, which is ignored by git. It reaches the service through a drop-in rather than being copied into the deployment checkout at `~/orbis-service`.

```sh
mkdir -p ~/.config/systemd/user/orbis-server.service.d
cat > ~/.config/systemd/user/orbis-server.service.d/key.conf <<'CONF'
[Service]
EnvironmentFile=%h/orbis/apps/server/.env.local
CONF
systemctl --user daemon-reload && systemctl --user restart orbis-server
```

Nothing is required for SoundCloud, which uses oEmbed. Without a key the server still saves a Set and records a failed metadata state, which the client offers to retry, so a missing key degrades rather than breaks.

`systemctl --user show -p Environment` will not show this value, because systemd reads the file at exec time. Check it by saving a Source Link with no title and reading `metadataState` in the response.

## Roll back

```sh
systemctl --user disable --now orbis-server
sudo tailscale serve --https=8444 off
```

Removing the Serve rule does not affect the jellyfin Funnel on `8443`. The database and trust store stay in `~/orbis-service-data`. Do not point the rule back at the local port 4310, which would restore token-free access from the tailnet.
