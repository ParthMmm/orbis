# Legacy Vanta API procedures

Historical archive for the Bun API before the Cloudflare Group cutover on 2026-10-03. Use these procedures only to review that deployment or prepare an approved rollback. The [current audio-node runbook](README.md) describes production.

For rollback after Group writes, read [Run the ADR 0018 cutover](#run-the-adr-0018-cutover) and [Transfer and restore Group data](../../docs/data-transfer.md). The pre-cutover Vanta database is stale. The [Roll back](#roll-back) section below only disables the old service and Serve bridge.

## Why a user service and a Serve bridge

The server binds `127.0.0.1` only, so nothing on the tailnet or the internet can reach it directly. `tailscale serve` terminates TLS for `vanta.example.ts.net` and proxies to a loopback port, which gives the native clients a trusted certificate without an App Transport Security exception and without publishing anything.

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
| `deploy/orbis-server/orbis-server.service` | Unit template. Adapt its checkout and data paths for a first install. Do not overwrite the current Vanta unit during an update. |
| `~/Developer/orbis-service` | A checkout of this repository on the branch being deployed. |
| `~/orbis` | The working checkout. Holds `apps/server/.env.local`, which supplies provider credentials and is ignored by git. |
| `~/Developer/orbis-service-data` | `ORBIS_DATA_DIR`. Holds `library.sqlite` and `devices.json`, outside the checkout so a pull cannot touch it. |
| `~/.config/systemd/user/orbis-server.service` | The installed unit. |

## Install or update

Run this on Vanta only, after the owner approves the host and the update window. The current checkout is `~/Developer/orbis-service`, and the data is `~/Developer/orbis-service-data`.

Keep the installed unit and its provider drop-ins. The repository template still uses `%h/orbis-service` and `%h/orbis-service-data`. Do not copy it over the current unit during an update. For a first install, change its `WorkingDirectory` and `ORBIS_DATA_DIR` to the current paths before installing it.

```sh
cd ~/Developer/orbis-service
git fetch origin && git checkout <branch> && git pull --ff-only

# Runtime preflight. Name the exact executable the unit uses, so the shell PATH
# cannot select another Bun. This recipe never installs a runtime.
BUN="$HOME/.local/share/mise/installs/bun/1.4.1/bin/bun"
if [ ! -x "$BUN" ]; then
  echo "bun 1.4.1 is not at $BUN. Install it with mise, then rerun." >&2
  exit 1
fi
if [ "$("$BUN" --version)" != "1.4.1" ]; then
  echo "$BUN reported $("$BUN" --version), expected 1.4.1. Fix the runtime, then rerun." >&2
  exit 1
fi

"$BUN" install --frozen-lockfile
"$BUN" run --filter @orbis/contracts build

EXPECTED_DIR="$HOME/Developer/orbis-service/apps/server"
if [ "$(systemctl --user show orbis-server -p WorkingDirectory --value)" != "$EXPECTED_DIR" ]; then
  echo "The installed unit does not use $EXPECTED_DIR. Stop and check its paths." >&2
  exit 1
fi
systemctl --user daemon-reload
BEFORE="$(systemctl --user show orbis-server -p InvocationID --value)"
echo "invocation before: ${BEFORE:-none}"

systemctl --user enable orbis-server
systemctl --user restart orbis-server
systemctl --user is-active --quiet orbis-server && echo "orbis-server is active"
echo "invocation after:  $(systemctl --user show orbis-server -p InvocationID --value)"
systemctl --user status orbis-server --no-pager
```

`enable` registers the unit at boot but does not touch a service that is already running. `restart` starts a stopped unit as well as a running one, so this single recipe covers both the first install and a later update. A recipe that used `enable --now` on an update would leave the old process running, and clients would keep talking to the old code.

`daemon-reload` re-reads unit definitions from disk. It never reloads application code; code changes take effect only when the process restarts. For the same reason, compare `InvocationID` before and after, not a PID: systemd allocates a new invocation ID to every start, while a PID can be reused by an unrelated process. On a first install the before value is empty. On an update the after value must differ, or the new code is not live.

The preflight covers the runtime only. The frozen install and the contracts build still run before any restart, so a missing package or a broken build stops the update while the old process keeps serving. The service uses `apps/server/src/index.ts` directly, so no server build step is needed. The shared contracts package must be built because the server imports its compiled types.

### If the update fails

Stop before the restart when the runtime preflight, the frozen install, or the contracts build fails; the running service is untouched. If the new process starts and then fails, go back to the last known-good checkout and runtime and restart the unit under owner control. Do not delete `~/Developer/orbis-service-data` or the trust records, and do not print environment files or secrets. A failed update does not touch the Serve rule or the jellyfin Funnel on `8443`.

### Record the update

Record the old and new `InvocationID`, the active status, the Bun version, and the expected HTTP status codes. In a plan-only or repository-only execution, record `live rollout not performed` instead of claiming the new process is live.

## A contract change ships with the service

A change to a field the apps decode is one change with the deploy of this service. Do not ship an app release that requires a new field, or that stops accepting an old one, until this unit is restarted on Vanta and the invocation check above shows the new process. Write `live rollout not performed` on the change when that restart did not happen.

The apps keep reading a library when a newer optional field is missing, so an old service does not look like a dead network. A response the app cannot decode is the Apple client's `malformed` failure, which names a mismatch between the app and the service.

## Enrol a device

Run this in the checkout with the same `ORBIS_DATA_DIR` the service uses. It prints the token once.

```sh
ORBIS_DATA_DIR=~/Developer/orbis-service-data bun apps/server/src/trust.ts add --label "iPhone 17 Pro"
ORBIS_DATA_DIR=~/Developer/orbis-service-data bun apps/server/src/trust.ts list
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

Orbis stays at `https://vanta.example.ts.net:8444`. A client must be given that address with the port. Port 443 stays with Caddy. Jellyfin's Funnel stays on `8443`.

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
  -H 'Host: localhost:4310' https://vanta.example.ts.net:8444/health
```

The expected result after cutover is 403, never 200. A normal request with no token must also return 403. An invalid token must return 401. A paired device must return 200; use the existing secret-injection mechanism (`$ORBIS_DEVICE_TOKEN`) and do not echo the token, add it to shell history, or save response payloads. If no safe injection mechanism is available, stop rather than invent one.

If validation fails, disable only the Orbis Serve rule (`sudo tailscale serve --https=8444 off`) instead of pointing it back at 4310. Local access and the stored data stay intact.

## Check from another tailnet machine

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://vanta.example.ts.net:8444/health
# 403, because there is no device token

curl -s -H "Authorization: Bearer $ORBIS_DEVICE_TOKEN" \
  https://vanta.example.ts.net:8444/health
# {"status":"ok"}
```

A 401 instead of a 403 means the token is present but not enrolled, so check the label in `trust.ts list`.

## Give the service provider credentials

Metadata enrichment reads a YouTube API key from the environment. The key lives in `apps/server/.env.local` in the working checkout at `~/orbis`, which is ignored by git. It reaches the service through a drop-in rather than being copied into the deployment checkout at `~/Developer/orbis-service`.

```sh
mkdir -p ~/.config/systemd/user/orbis-server.service.d
cat > ~/.config/systemd/user/orbis-server.service.d/key.conf <<'CONF'
[Service]
EnvironmentFile=%h/orbis/apps/server/.env.local
CONF
systemctl --user daemon-reload && systemctl --user restart orbis-server
```

Nothing is required for SoundCloud, which uses oEmbed. Without a key the server still saves a Set and records a failed metadata state, which the client offers to retry, so a missing key degrades rather than breaks.

## Give the service yt-dlp

YouTube downloads try yt-dlp first and fall back to Cobalt. Without `ORBIS_YTDLP_BIN`, every YouTube download goes to Cobalt, whose tunnel returned zero bytes for long videos on 2026-09-29. yt-dlp needs Deno, and the service's default PATH does not include `~/.local/bin`, where `uv tool install` puts both.

```sh
cat > ~/.config/systemd/user/orbis-server.service.d/ytdlp.conf <<'CONF'
[Service]
Environment=ORBIS_YTDLP_BIN=%h/.local/bin/yt-dlp
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
CONF
systemctl --user daemon-reload && systemctl --user restart orbis-server
```

The worker logs `ytdlp: true` at startup when the binary is configured.

`systemctl --user show -p Environment` will not show this value, because systemd reads the file at exec time. Check it by saving a Source Link with no title and reading `metadataState` in the response.

## Cut over to Cloudflare and an API-only Funnel

### Prepare the Group cutover

ADR 0018 replaces the API on Vanta with the Group. Issues [#192](https://github.com/ParthMmm/orbis/issues/192), [#193](https://github.com/ParthMmm/orbis/issues/193), and [#194](https://github.com/ParthMmm/orbis/issues/194) must pass their acceptance checks before moving live data in [#195](https://github.com/ParthMmm/orbis/issues/195).

The Vanta process has three modes. With both switches unset, it serves the API as before. `ORBIS_READ_ONLY=true` refuses `POST`, `PUT`, `PATCH`, and `DELETE` with `503` and `Retry-After: 60`; reads and audio continue. The process stops starting Download work and recording key usage in this mode. Restart into this mode before export so work from the previous process has stopped.

`ORBIS_API_FORWARD_URL=https://orbis.p11a.xyz/api` forwards every request except `/sets/:id/audio` to the Group. It preserves the key, body, query, redirects, and event stream. The local listener also forwards, so it cannot write a second copy of the Library after cutover. Audio stays on Vanta. The process refuses to start if forwarding and read-only mode are both enabled.

Forwarded requests emit `ingress: "funnel-forward"` with the key's label, request path, and status. Keys and query strings stay out of the log. Read these events with:

```sh
	journalctl --user -u orbis-server --since '14 days ago' -o cat |
	  jq -cR 'fromjson? | select(.ingress == "funnel-forward") | {timestamp, keyLabel, method, path, status}'
```

An empty result is evidence only when the journal covers the whole interval and forwarding was active throughout it. Keep forwarding until the Host confirms 14 days without requests, per [#199](https://github.com/ParthMmm/orbis/issues/199).

Set these switches in a dedicated service drop-in. Preserve the existing unit, provider settings, data directory, and backup and canary timers. To cancel a read-only window before switching clients, remove the dedicated switch and restart the same revision. After the Group has accepted writes, restore its current export before returning to the Vanta API; the earlier Vanta copy is stale. Neither switch changes a Tailscale rule.

Verify the controls locally with `bun test src/cutover-http.test.ts` from `apps/server`. This repository check does not move live data or perform a deployment.

### Run the ADR 0018 cutover

Do not open the read-only window until the local Group, real audio node, SQL transfer, grant, web player, and Cortex Apple checks pass. Record their artifact paths and the exact revision. Keep #195 open if any production acceptance check remains unverified.

Prepare these items while Vanta still serves writes:

1. Record the current service revision, `InvocationID`, installed unit and drop-in paths, active timers, and Serve and Funnel status. Preserve a consistent SQLite snapshot, the legacy trust file, and the stream secret in a private rollback directory. Copy the secret without changing it.
2. Update the production checkout to the verified revision without replacing local changes or the installed unit. Install frozen dependencies and build contracts and the audio node before restarting anything.
3. Deploy the Group with the existing stream secret and provider credentials. Keep the web API URL on Vanta. Verify public Group health and the web page. Keep recovery disabled until its actual Access issuer and Host email are configured. Do not mint recovery keys in the empty migration target.
4. Migrate trust on Vanta with the API build, with read-only and forwarding unset. Verify the renamed JSON file and every existing key's Person and scope. Preserve the migrated database as well as the pre-migration snapshot.
5. Mint one node key in Vanta SQLite. Store its token in a private environment file with mode `0600`. Configure `IMPORT_NODE_KEY_DIGEST` from that same token for the empty Group. Never connect the live audio directory before import validation, because inventory reconciliation can release files.
6. Rehearse export, import, checksum comparison, Host HTTP readback, export, and restore against a scratch Group. Build the web client and prepare the service and backup settings before the timed window. Keep legacy SQLite backup snapshots separate from SQL retention.

Use one dedicated `group-cutover.conf` drop-in for migration settings. Preserve the existing provider drop-ins and timer units. Record timestamps in UTC and check both reads and a refused write in the request logs.

1. Set `ORBIS_READ_ONLY=true` in the dedicated drop-in, reload systemd, and restart the current API entrypoint. Record the new `InvocationID`. Confirm a write returns `503` with `Retry-After` and reads still work. This restart stops the old Download worker before export. If preparation or validation cannot finish within ten minutes, remove the read-only setting and restart this API revision before clients switch.
2. Export the final `library.sqlite` with `scripts/data-transfer.ts export`, then import it with `scripts/data-transfer.ts import`. Compare every table count and checksum. Read the Host's Library, Playlists, Queue, positions, and titles from the Group. Compare copied trust digests, Person IDs, and scopes. Do not switch clients on a mismatch. A failed import rolls back. Keep the Vanta API read-only until a retry or rollback finishes.
3. After validation, remove `ORBIS_READ_ONLY`. Override only the service entrypoint to `src/node.ts` and load the private node environment file. Set `ORBIS_GROUP_URL=https://orbis.p11a.xyz/api`, `ORBIS_AUDIO_DIR` to the existing audio directory, `ORBIS_STREAM_SECRET_FILE` to the preserved stream key, and `ORBIS_API_FORWARD_URL=https://orbis.p11a.xyz/api`. Keep the node listener at `127.0.0.1:4311`. Reload systemd and restart the same service. Record its new `InvocationID` and successful node connection.
4. Verify an existing key through both addresses and an older Apple build through forwarding. Verify grant-only audio, a Range response, playback, seeking, and forwarded key labels in the Vanta journal. Check that a node key cannot use a client route. The database-free node does not listen on the old token-free port `4310`.
5. Set the web client's `ORBIS_API_URL` to `https://orbis.p11a.xyz/api` and deploy the same Alchemy stack. Keep `ORBIS_AUDIO_URL` on the Funnel audio origin. Run the four production browser journey groups with a temporary test Person, preserve screenshots, and remove that Person. Measure the write outage from the last refused Vanta write to the first successful Group write.
6. Add the Group export URL and node key to the existing private backup environment file. Preserve the destination and timers. The backup script writes and mirrors only its `group/` or `sqlite/` subdirectory. It leaves legacy snapshots in the destination root and the other backup format untouched. Verify both before enabling the timer. Run a backup and restore it to a fresh scratch database. Keep the nightly six-check canary and record its next result.
7. Remove the bootstrap import digest from the Worker configuration. Keep forwarding, Serve mappings, and the Jellyfin Funnel until their separate retirement criteria pass. Do not close #199 until the Vanta node journal proves 14 complete days without forwarded requests. Group ingress headers are client supplied and cannot establish this retirement evidence.

Before the Group accepts writes, rollback removes the dedicated cutover settings and restarts the migrated Vanta API. Keep the Group isolated from clients and keep both exported copies for diagnosis. Do not reconnect the audio directory to an empty or mismatched Group.

After the Group accepts writes, the old Vanta database is stale. Quiesce Group writes, take a current node-authenticated Group export, restore it to a new SQLite file, and compare its manifest and Host HTTP readback in scratch. Preserve the existing Vanta database and its WAL files before installing the verified restore. Restore the API entrypoint and web URL together, then verify existing keys and playback. If the Group cannot export, keep it as the data authority and repair access rather than replacing it with the old Vanta snapshot. No rollback resets Tailscale, Caddy, or unrelated services.

### Earlier web deployment procedure

Friends open `https://orbis.p11a.xyz`. Alchemy deploys the web client from `apps/web` to Cloudflare Workers. The browser sends its key directly to `https://vanta.tail01d084.ts.net:10000/api`, and Retained Audio stays on Vanta. The Funnel on port `10000` serves only `/api`. See [ADR 0015](../../docs/adr/0015-web-on-cloudflare-workers.md).

Run the local browser journeys in [`apps/web/README.md`](../../apps/web/README.md) first. Keep the previous service revision and the Serve status output for recovery. This repository change does not perform a live rollout.

The API includes the new Playlist routes before the web client calls them. Deploy the API and web client in the following order, after the owner approves the Vanta update and Cloudflare deploy:

1. On Vanta, record `tailscale serve status` and `tailscale funnel status`. The Caddy rule on `443` and Jellyfin Funnel on `8443` must stay unchanged throughout the cutover.
2. Update the checkout at `~/Developer/orbis-service` with the matching revision using [Install or update](#install-or-update). Build contracts and restart the existing installed unit. Keep `ORBIS_DATA_DIR` at `~/Developer/orbis-service-data`. Do not reinstall the repository unit template or replace the provider drop-ins. Confirm the new `InvocationID` and active status. The old web Origin now gets 403. Check the Cloudflare preflight and keyed health before the web deploy.
3. On the Mac, install dependencies with `bun install --frozen-lockfile`. Build `@orbis/contracts`, then use the existing Alchemy identity. Run from `apps/web`:

```sh
	./node_modules/.bin/alchemy profile edit --profile default --add Cloudflare
	./node_modules/.bin/alchemy deploy --stage prod --dry-run
	bun run deploy
```

The profile command opens Cloudflare OAuth for first setup. For an established profile, refresh it only when needed. Keep stack `OrbisWeb`, resource `Web`, and stage `prod` unchanged. A directory rename must not create a second Worker or remove the current domain.

4. Open `https://orbis.p11a.xyz` in a browser. Confirm sign-in, Library, creator and editor Playlist actions, shared playback, stream-grant audio, queue updates, and Device Link. Verify that the response carries the Content Security Policy. Keep exported screenshots and the revision with the rollout record.
5. On Vanta, remove only the root handler on port `10000`, then ensure `/api` remains public:

```sh
	sudo tailscale serve --https=10000 --set-path=/ off
	sudo tailscale funnel --bg --https=10000 --set-path=/api http://127.0.0.1:4311/
	tailscale serve status
	tailscale funnel status
```

Do not reset Serve or disable all of port `10000`. The status must show `/api` targeting `4311`, no `/` file handler on `10000`, and the unchanged Jellyfin Funnel on `8443`. The device listener must receive `/health`, not `/api/health`. Serve strips the mount path when it proxies.

6. From another network off the tailnet, check the public API and both browser Origins:

```sh
	curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
	  https://vanta.tail01d084.ts.net:10000/api/health
	curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
	  -H "Authorization: Bearer $ORBIS_DEVICE_TOKEN" \
	  https://vanta.tail01d084.ts.net:10000/api/health
	curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
	  -X OPTIONS -H 'Origin: https://orbis.p11a.xyz' \
	  -H 'Access-Control-Request-Method: POST' \
	  -H 'Access-Control-Request-Headers: authorization, content-type' \
	  https://vanta.tail01d084.ts.net:10000/api/sets
	curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
	  -X OPTIONS -H 'Origin: https://vanta.tail01d084.ts.net:10000' \
	  https://vanta.tail01d084.ts.net:10000/api/sets
```

Expect `403`, `200`, `204`, and `403`, in that order. Inject the existing device token without printing it or saving response data. The keyed `200` proves path stripping. A `404` means the mount path is wrong. A `401` means the key is not enrolled. Also confirm an enrolled Apple client still reads the Library and plays audio.

7. Record the revision, Cloudflare deployment result, old and new service `InvocationID`, all four HTTP statuses, and Serve and Funnel status. Point friends at `https://orbis.p11a.xyz` after these checks pass.

If the Cloudflare page fails, preserve `/api` and the stored data while restoring the previous Cloudflare deployment. If the API fails after restart, restore the known-good service revision under owner control. Do not expose the local listener on `4310`, delete service data, or reset unrelated Serve rules. Restoring the retired browser client requires both its old static files and its Origin permission, so that recovery is an explicit owner decision.

### Retire the tailnet-only rule

After every native client and the Raycast extension use `https://vanta.tail01d084.ts.net:10000/api` (the Apple app and Raycast accept an address with a path), remove the old bridge and confirm:

```sh
sudo tailscale serve --https=8444 off
tailscale serve status
```

## Roll back

```sh
systemctl --user disable --now orbis-server
sudo tailscale serve --https=8444 off
```

Removing the Serve rule does not affect the jellyfin Funnel on `8443`. The database and trust store stay in `~/Developer/orbis-service-data`. Do not point the rule back at the local port 4310, which would restore token-free access from the tailnet.

## Trust data in SQLite

The service and `bun run trust` store People, API key digests, and Invites in `library.sqlite`. On the first start, the service imports `devices.json` in one SQLite transaction. It copies key and Invite digests unchanged, then renames the file to `devices.json.migrated`. A malformed file or a failed transaction leaves the source file in place and prevents startup. Later starts use the tables and ignore any new `devices.json`. Unexpired Invites survive a restart.

`ORBIS_DATA_DIR` selects the directory for both commands. To select a database explicitly, use `bun run trust key list --database /path/to/library.sqlite`. The old `--devices` option still selects a legacy file and imports it into `library.sqlite` in the same directory. The nightly SQLite snapshot includes all trust tables. Keep the renamed JSON file until you no longer need rollback.

To roll back to the previous build:

1. Stop the service.
2. Preserve a copy of the current `library.sqlite` and its WAL files.
3. Restore `devices.json.migrated` as `devices.json`.
4. Restore the previous build and start the service.

The restored JSON contains trust data from before the migration. Keys, People, and Invites added or changed after migration do not carry back to the old build. Keep the SQLite copy so those changes remain available if you return to this build.
