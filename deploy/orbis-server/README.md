# Orbis API on Vanta

The API runs as a systemd user service that binds loopback only. Tailscale Serve bridges the tailnet address to that loopback port. No port is published and no Funnel is added.

## Why a user service and a Serve bridge

The server keeps binding `127.0.0.1`, so nothing on the tailnet or the internet can reach it directly. `tailscale serve` terminates TLS for `vanta.tail01d084.ts.net` and proxies to the loopback port, which gives the native clients a trusted certificate without an App Transport Security exception and without publishing anything.

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
sudo tailscale serve --bg --https=8444 http://127.0.0.1:4310
tailscale serve status
tailscale funnel status
```

The Serve rule must read `tailnet only`. The existing jellyfin Funnel on `8443` must be unchanged.

**Port 443 is not available on this host.** Caddy runs as a container bound directly to the tailnet address on `443`, so `tailscale serve` cannot bind there. The failure is silent. `tailscale serve` prints `Serve started and running in the background`, and then `tailscale serve status` does not list the rule at all, because Tailscale drops a mapping it cannot bind. A client that asks for the bare hostname therefore reaches whatever Caddy is serving and gets that application's HTML, not a connection error and not a 403.

Orbis is therefore served at `https://vanta.tail01d084.ts.net:8444`, and a client must be given that address with the port. Resolving the `443` conflict is the host owner's decision and is not needed for Orbis to work.

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

Removing the Serve rule does not affect the jellyfin Funnel on `8443`. The database and trust store stay in `~/orbis-service-data`.
