# Orbis API on Vanta

The API runs as a systemd user service that binds loopback only. Tailscale Serve bridges the tailnet address to that loopback port. The device listener also serves the public `/api` path through Funnel on port `10000`. The web client runs on Cloudflare.

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

## Check downloads every night

`apps/server/src/canary.ts` downloads a short and a long Set per source through each configured backend, using the worker's own code, and checks that each stored file has the expected duration. It catches a backend that stops working before a user's download does: on 2026-09-29, Cobalt returned empty YouTube streams for long videos while short ones still worked.

Keep the existing canary service and timer during a cutover. Do not recopy the repository templates over them. For a first install, adapt `orbis-canary.service` before installing it and its timer. Set `WorkingDirectory=%h/Developer/orbis-service/apps/server` and `ORBIS_DATA_DIR=%h/Developer/orbis-service-data`. Keep `ExecStart` on the Bun `1.4.1` binary with `src/canary.ts`, and preserve the provider environment file and yt-dlp settings.

For installed units, check and run the timer:

```sh
systemctl --user daemon-reload
systemctl --user enable --now orbis-canary.timer
systemctl --user start orbis-canary.service   # first run now; takes a few minutes
```

It downloads about 400 MB a night and keeps none of it.

## Where to look when a download fails

Each record below is written for an agent to read without extra setup. The service and the canary log one JSON object per line when stdout is not a terminal, as under systemd.

```sh
# Did last night's canary pass, and when did it start failing?
cat ~/Developer/orbis-service-data/canary/last.json
jq -c '{at, ok}' ~/Developer/orbis-service-data/canary/history.jsonl | tail

# Is any unit failing?
systemctl --user --failed

# Why did a download fail? One wide event per download.
journalctl --user -u orbis-server --since today -o cat |
  jq -cR 'fromjson? | select(.job == "audio-download" and .outcome != "success")'

# What did the canary see?
journalctl --user -u orbis-canary --since today -o cat |
  jq -cR 'fromjson? | select(.job == "download-canary")'
```

A download's wide event (`job: audio-download`) lists every backend attempt in `logs`: bytes received, yt-dlp's exit code and the end of its error output, Cobalt's tunnel status and content length, and ffprobe's error output. The canary's event (`job: download-canary`) holds the same evidence for each check. The startup line `youtube downloads use cobalt only` means `ORBIS_YTDLP_BIN` is missing; see [Give the service yt-dlp](#give-the-service-yt-dlp).

## Back up the Group

After cutover, the nightly timer calls `scripts/data-transfer.ts backup`, which fetches the Group's SQL export with the node key and retains the newest 14 SQL files. The existing script then rsyncs the staging directory to `ORBIS_BACKUP_DEST`. SQL includes library and trust tables, so new backups do not need `devices.json`.

Keep the installed service, timer, destination, and environment file. Do not recopy the repository templates over them. At cutover, add these values to the existing private environment file without changing its destination:

```sh
ORBIS_GROUP_API_URL=https://orbis.p11a.xyz/api
ORBIS_NODE_KEY=<the imported node key>
```

Keep `~/.config/orbis-backup.env` at mode `0600`. Keep the current `ORBIS_BACKUP_STAGING` if one exists. A remote destination requires key-based SSH for the service user. The script does not change the installed units or network configuration.

Before cutover, `apps/server/src/backup.ts` remains available for local SQLite snapshots. Preserve the installed backup configuration until the Group owns the data.

### Restore

Restore into a new scratch database before replacing service data:

```sh
bun scripts/data-transfer.ts restore /private/backups/chosen.sql /private/restore/library.sqlite
```

Set `ORBIS_DATA_DIR` to the scratch directory and start the Bun API against it. Check the Host's Library, Playlists, Listening Queue, positions, and edited titles. For a rollback after Group writes, use a current Group export. The Vanta copy from before cutover is stale.

See [Transfer and restore Group data](../../docs/data-transfer.md) for import, node authentication, and the repeatable workerd and Bun verification command.

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

Friends open `https://orbis.p11a.xyz`. Alchemy deploys the web client from `apps/web` to Cloudflare Workers. The browser sends its key directly to `https://vanta.tail01d084.ts.net:10000/api`, and Retained Audio stays on Vanta. The Funnel on port `10000` serves only `/api`. See [ADR 0015](../../docs/adr/0015-web-on-cloudflare-workers.md).

Run the local browser journeys in [`apps/web/README.md`](../../apps/web/README.md#verify-the-migration) first. Keep the previous service revision and the Serve status output for recovery. This repository change does not perform a live rollout.

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

## Group foundation on Cloudflare

The `OrbisWeb` Alchemy stack now also owns an API Worker on `orbis.p11a.xyz/api/*` and one SQLite Group Durable Object. Only health is available in this foundation. The web client's API URL, active database, and audio remain on Vanta until the ADR 0018 cutover. Deploy, destroy, migration generation, local schema verification, and post-deploy HTTP checks are in the [API deploy README](../../apps/api/README.md). Destroying the stack also destroys Group data.

## Trust data in SQLite

The service and `bun run trust` store People, API key digests, and Invites in `library.sqlite`. On the first start, the service imports `devices.json` in one SQLite transaction. It copies key and Invite digests unchanged, then renames the file to `devices.json.migrated`. A malformed file or a failed transaction leaves the source file in place and prevents startup. Later starts use the tables and ignore any new `devices.json`. Unexpired Invites survive a restart.

`ORBIS_DATA_DIR` selects the directory for both commands. To select a database explicitly, use `bun run trust key list --database /path/to/library.sqlite`. The old `--devices` option still selects a legacy file and imports it into `library.sqlite` in the same directory. The nightly SQLite snapshot includes all trust tables. Keep the renamed JSON file until you no longer need rollback.

To roll back to the previous build:

1. Stop the service.
2. Preserve a copy of the current `library.sqlite` and its WAL files.
3. Restore `devices.json.migrated` as `devices.json`.
4. Restore the previous build and start the service.

The restored JSON contains trust data from before the migration. Keys, People, and Invites added or changed after migration do not carry back to the old build. Keep the SQLite copy so those changes remain available if you return to this build.

### Run the audio node

After moving the library database to the Group, run `bun run node` from `apps/server`. Build its entrypoint with `bun run build:node` and start the result with `bun dist/node.js`.

Set `ORBIS_GROUP_URL` to the API base URL, such as `https://orbis.p11a.xyz/api`, and `ORBIS_NODE_KEY` to a key minted with `bun run trust key add --person host --label vanta --scope node`. The Group accepts that key on `/api/node`; it does not grant client API access. Set `ORBIS_AUDIO_DIR` to the existing audio directory and `ORBIS_STREAM_SECRET_FILE` to the existing 32-byte `stream-grant.key` file. The node refuses to start if that secret is missing or has the wrong size. `ORBIS_NODE_HOST` and `ORBIS_NODE_PORT` default to `127.0.0.1` and `4311`. The listener serves grant-authorized audio. Keep the existing provider settings, yt-dlp binary, cookies, ffprobe, and ffmpeg.

The node opens an outbound WebSocket and reconnects with exponential backoff, capped at 30 seconds. Its files are its only persistent state. Each connection reports validated audio files. The Group reconciles missing and unreferenced files and resumes interrupted Downloads using the existing job rows. Download commands and replies carry a Set ID and a request ID; a result from a canceled attempt cannot finish a later attempt.

Keep the nightly canary service and timer. Its three fixtures across two configured backends still produce six checks through `DownloadBackends` and `MediaStore`, which the node also uses.

Run `bun run --cwd apps/api test:node` to exercise the local Group with a fake node and the built node process. The journey writes a protocol transcript and process log under `.cache/audio-node/<run>/`, including a forced process stop, recovery of the same job, progress through the API, and file deletion after removing the Library Entry. It needs ffmpeg and ffprobe on `PATH`.
