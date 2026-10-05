# Run the Orbis audio node on Vanta

The production API and database moved to the Cloudflare Group on 2026-10-03. Vanta runs the database-free audio node as the existing systemd user service at `127.0.0.1:4311`. The Funnel on port `10000` serves audio and forwards old `/api` requests to the Group. The web client runs on Cloudflare.

For Cloudflare deployment, use the [API deploy README](../../apps/api/README.md). For Group backup recovery, use [Transfer and restore Group data](../../docs/data-transfer.md). For the earlier Bun API installation, pairing, or cutover rollback, use the [legacy API archive](legacy-api.md).

## Production files and services

| Path | Purpose |
| --- | --- |
| `~/Developer/orbis-service` | Production checkout. |
| `~/Developer/orbis-service-data` | Retained Audio, stream secret, and canary records. The pre-cutover SQLite database and trust files are rollback records, not live Group data. |
| `~/.config/systemd/user/orbis-server.service` | Installed service and its drop-ins. The production entrypoint is `src/node.ts`. |
| `deploy/orbis-server/orbis-server.service` | Pre-cutover API template using `src/index.ts`. Preserve the installed audio-node unit during updates. |

Keep the installed service, provider settings, backup and canary timers, and private environment files. Caddy reserves Tailscale port `443`. Keep the Jellyfin Funnel on `8443`.

## Run the audio node

For a standalone audio-node process, run `bun run node` from `apps/server`. Build its entrypoint with `bun run build:node` and start the result with `bun dist/node.js`.

Set `ORBIS_GROUP_URL` to the API base URL, such as `https://orbis.p11a.xyz/api`, and retain the imported node key in `ORBIS_NODE_KEY`. [Transfer and restore Group data](../../docs/data-transfer.md#import-into-an-empty-group) covers node-key creation for migration. The Group accepts that key on `/api/node`. It does not grant client API access.

Set `ORBIS_AUDIO_DIR` to the existing audio directory and `ORBIS_STREAM_SECRET_FILE` to the existing 32-byte `stream-grant.key` file. The node refuses to start if that secret is missing or has the wrong size. `ORBIS_NODE_HOST` and `ORBIS_NODE_PORT` default to `127.0.0.1` and `4311`.

The installed node keeps `ORBIS_API_FORWARD_URL=https://orbis.p11a.xyz/api` for older clients. The listener serves grant-authorized audio and forwards every other API request without a local database or trust store. Retire forwarding only after the [forwarding retirement checks](#retire-api-forwarding) pass. Keep the existing provider settings, yt-dlp binary, cookies, ffprobe, and ffmpeg.

The node opens an outbound WebSocket and reconnects with exponential backoff, capped at 30 seconds. Its files are its only persistent state. Each connection reports validated audio files. The Group reconciles missing and unreferenced files and resumes interrupted Downloads using the existing job rows. Download commands and replies carry a Set ID and a request ID; a result from a canceled attempt cannot finish a later attempt.

Run `bun run --cwd apps/api test:node` to exercise the local Group with a fake node and the built node process. The journey writes a protocol transcript and process log under `.cache/audio-node/<run>/`, including a forced process stop, recovery of the same job, progress through the API, and file deletion after removing the Library Entry. It needs ffmpeg and ffprobe on `PATH`.

## Update the installed service

Use the approved Vanta update window. Preserve the installed unit and drop-ins; the repository unit template still starts the legacy API.

1. Check the installed unit's `WorkingDirectory` and `ExecStart` with `systemctl --user cat orbis-server`. Confirm the production checkout and audio-node entrypoint without printing private environment files.
2. Update that checkout to the approved revision. Use the unit's exact Bun executable for the frozen install and shared-contract build. Complete both before restarting.
3. Record `systemctl --user show orbis-server -p InvocationID --value`, restart the existing service, and confirm its new invocation and active status.
4. Check [API forwarding](#check-the-api-and-forwarding), authenticated audio playback, and the [download canary](#check-downloads-every-night). Record the deployed commit and results. If rollout was not performed, state that on the issue or PR.

## Enrol a device

Use the Group's web admin page to mint a separate daily key for the Person and device. Copy the key into the client and keep it out of the repository. Clients that support Device Link can obtain a daily key from an already signed-in device. See [Sign in by Invite and Device Link](../../docs/adr/0016-sign-in-by-invite-and-device-link.md).

## Check the API and forwarding

`GET /api/health` is public on the Group and returns `200`. While forwarding is active, the old Funnel health address also returns `200` without a key. Health alone does not verify authentication or audio playback.

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://orbis.p11a.xyz/api/health
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  https://vanta.tail01d084.ts.net:10000/api/health
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  -H "Authorization: Bearer $ORBIS_DEVICE_TOKEN" \
  https://vanta.tail01d084.ts.net:10000/api/sets
```

Expect `200` for both health requests and for `/api/sets` with a valid daily key. Inject the existing key without printing it or saving response data. On `/api/sets`, a missing key returns `403`, an invalid key returns `401`, and a node key returns `403`. Audio requires a signed stream grant from the Group.

## Check downloads every night

`apps/server/src/canary.ts` downloads a short and a long Set per source through each configured backend, using the worker's own code, and checks that each stored file has the expected duration. It catches a backend that stops working before a user's download does: on 2026-09-29, Cobalt returned empty YouTube streams for long videos while short ones still worked.

Keep the existing canary service and timer. Do not recopy the repository templates over them. For a first install, adapt `orbis-canary.service` before installing it and its timer. Set `WorkingDirectory=%h/Developer/orbis-service/apps/server` and `ORBIS_DATA_DIR=%h/Developer/orbis-service-data`. Keep `ExecStart` on the Bun `1.4.1` binary with `src/canary.ts`, and preserve the provider environment file and yt-dlp settings.

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

A download's wide event (`job: audio-download`) lists every backend attempt in `logs`: bytes received, yt-dlp's exit code with the start and end of its error output, Cobalt's tunnel status and content length, and ffprobe's error output. The `stderrHead` annotation names yt-dlp's identifying error; `stderr` keeps the end, where its hint is. The canary's event (`job: download-canary`) holds the same evidence for each check. The startup line `youtube downloads use cobalt only` means `ORBIS_YTDLP_BIN` is missing; see [Check the yt-dlp configuration](#check-the-yt-dlp-configuration).

## Check the yt-dlp configuration

YouTube downloads try yt-dlp first and fall back to Cobalt. Without `ORBIS_YTDLP_BIN`, every YouTube download goes to Cobalt, whose tunnel returned zero bytes for long videos on 2026-09-29. yt-dlp needs Deno, and the service's default PATH does not include `~/.local/bin`, where `uv tool install` puts both.

Preserve the installed provider drop-ins, `ORBIS_YTDLP_BIN`, PATH, and cookies. The worker logs `ytdlp: true` at startup when the binary is configured. The [legacy yt-dlp setup](legacy-api.md#give-the-service-yt-dlp) records the earlier drop-in procedure.

## Back up the Group

After cutover, the nightly timer calls `scripts/data-transfer.ts backup`, which fetches the Group's SQL export with the node key and retains the newest 14 SQL files. The existing script then rsyncs the staging directory to `ORBIS_BACKUP_DEST`. SQL includes library and trust tables, so new backups do not need `devices.json`.

Keep the installed service, timer, destination, and environment file. Do not recopy the repository templates over them. The existing private environment file needs these values alongside its destination:

```sh
ORBIS_GROUP_API_URL=https://orbis.p11a.xyz/api
ORBIS_NODE_KEY=<the imported node key>
```

Keep `~/.config/orbis-backup.env` at mode `0600`. Keep the current `ORBIS_BACKUP_STAGING` if one exists. A remote destination requires key-based SSH for the service user. The script does not change the installed units or network configuration.

### Restore

Use [Transfer and restore Group data](../../docs/data-transfer.md#export-and-restore) to restore into a new scratch database and verify it before replacing service data. For a rollback after Group writes, use a current Group export. The Vanta copy from before cutover is stale.

## Retire API forwarding

Forwarded requests emit `ingress: "funnel-forward"` with the key's label, request path, and status. Keys and query strings stay out of the log. Read these events with:

```sh
	journalctl --user -u orbis-server --since '14 days ago' -o cat |
	  jq -cR 'fromjson? | select(.ingress == "funnel-forward") | {timestamp, keyLabel, method, path, status}'
```

An empty result is evidence only when the journal covers the whole interval and forwarding was active throughout it. Keep forwarding until the Host confirms 14 complete days without requests, per [#199](https://github.com/ParthMmm/orbis/issues/199). Group ingress headers are client supplied and cannot establish this evidence. Keep forwarding and the existing Serve mappings until those checks pass.

## Cutover evidence

The 2026-10-03 cutover retained existing key digests and stopped writes for at most 50.441 seconds in the request logs. A Group backup restored successfully, and an Apple build using the old Funnel address played and sought production audio.

The first canary after cutover passed four of six checks because both YouTube yt-dlp downloads required authentication. After the Host supplied fresh cookies, the installed canary service passed all six checks at `2026-10-03T22:50:46.589Z`. Both runs were triggered manually. At that snapshot, the next scheduled run was due at 04:00 PDT. Use the [canary records](#where-to-look-when-a-download-fails) for the latest result and [#195](https://github.com/ParthMmm/orbis/issues/195) for production acceptance.
