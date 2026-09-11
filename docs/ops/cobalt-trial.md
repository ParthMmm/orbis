# Private Cobalt trial on Vanta

This is an isolated feasibility trial for audio downloads. It does not add downloads to Orbis and does not publish the Orbis server.

The implementation baseline checked before remote work was `23d0c82` on `main`.

Read [the trial evidence](cobalt-trial-evidence.md) before repeating the deployment. It records what the first run measured, including a YouTube failure that the derived image below fixes. Keep Cobalt as a separate service, and keep its own code unmodified: the one departure from upstream is a vendored client library, and [the decision record](../adr/0003-cobalt-youtube-client.md) explains why. The Cobalt API is licensed under AGPL-3.0; review the license before modifying or redistributing it.

## Fixed deployment

The Compose file is [`deploy/cobalt/compose.yaml`](../../deploy/cobalt/compose.yaml) and the image is built by [`deploy/cobalt/Dockerfile`](../../deploy/cobalt/Dockerfile). The deployment uses:

- Official Cobalt version 11 as the base, pinned to the Linux amd64 image manifest `sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b`.
- The base image's index digest `sha256:63186dd68afd57ce3bb1f62cc4c139f5fa95b9c3e87a3cf5c6e4c7a570523f62`, for cross-checking the tag resolution.
- `youtubei.js` 18.0.0 in place of the 17.0.1 that Cobalt 11.7.1 vendors, pinned by the `YOUTUBEI_VERSION` build argument. Version 18.0.0 is the first release with the `VISIONOS` client, whose YouTube stream URLs are the only ones this deployment can download in full.
- `CUSTOM_INNERTUBE_CLIENT=VISIONOS`, which selects that client.
- A distinct `orbis-cobalt-trial` container with a read-only filesystem, an init process, and `unless-stopped` restart policy.
- Port `9000` published only on Vanta's Tailscale IPv4 address.
- API-key authentication required for processing requests. The key file is mounted read-only and is not tracked by Git.
- YouTube and SoundCloud only. Both the global disabled-service list and the generated API key restrict the trial to these sources.
- A six-hour (`21600` second) duration limit and finite rate limits.

The base image is pinned by digest, so it carries no tag to resolve and no registry digest of its own to compare against. What identifies the built image instead is the pair recorded in the Dockerfile plus the local image ID, `sha256:814f3e023bf6a7a2529e26ee89e3f8af010d483eaf0938e6cd2791dc7c4cd80a` at the time of writing. Rebuilding from the same base digest and the same `YOUTUBEI_VERSION` reproduces it.

The `.env.example` file records the address observed during the initial read-only check. Recheck it on Vanta before every deployment; do not assume the Tailscale address is permanent.

## Prerequisites

Run the deployment and live smoke check on Vanta. The Mac can review the configuration but is not the download host.

- SSH access with `ssh vanta`.
- Docker and Docker Compose, with network access from the host for the image build, which installs one npm package.
- A current Tailscale IPv4 address and no service using port 9000.
- Node.js 24, `ffmpeg`, and `ffprobe` on the machine running the smoke check.
- Public YouTube and SoundCloud URLs that the operator is allowed to download. Include one set longer than three hours and no longer than six hours.
- Enough temporary disk space for one sequential audio download. The smoke check deletes media after each case and on interruption.

Before changing Vanta, run this read-only check and save its output with the trial notes:

```sh
ssh vanta bash -s <<'REMOTE'
set -eu
uname -a
docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
docker compose version
nproc
free -h
df -h /
tailscale ip -4
ss -ltnp | grep ':9000 ' || true
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
tailscale serve status || true
tailscale funnel status || true
REMOTE
```

Confirm that the host is Vanta, the architecture is `linux/amd64`, port 9000 is unused, and existing containers and routes are unchanged. Do not run `docker system prune`, change Caddy, or change Tailscale Serve/Funnel rules.

## Provision and start

Use a checkout of this repository on Vanta. Keep `.env` and `keys.json` in `deploy/cobalt`; both are ignored by Git. Do not put the API key in a tracked file, shell history, command trace, or evidence report.

```sh
cd /path/to/orbis/deploy/cobalt
cp .env.example .env
```

Set `VANTA_TAILSCALE_IP` to the address returned by `tailscale ip -4`. Set `COBALT_API_URL` to `http://<that-address>:9000/`, using the same address and port. Do not use `0.0.0.0`, `127.0.0.1`, a public domain, or a Funnel URL.

Generate a new key outside source control. The command prints the key once so it can be stored in a password manager; do not copy that output into a log.

```sh
node ../../scripts/create-cobalt-key.mjs --output keys.json
chmod 600 keys.json
```

The generated key has a finite limit and `allowedServices` set to exactly `youtube` and `soundcloud`. Rotate it with `--force` only when a new key is needed, then restart Cobalt.

Validate the Compose file without expanding secrets into a log:

```sh
docker compose --env-file .env -f compose.yaml config --quiet
docker buildx imagetools inspect \
  ghcr.io/imputnet/cobalt:11
```

Check that the inspected amd64 manifest digest is the base digest recorded above. Build and start only this Compose service. The build reads nothing from the directory, and `deploy/cobalt/.dockerignore` enforces that, so no key or environment file can enter the image:

```sh
docker compose --env-file .env -f compose.yaml build cobalt
docker compose --env-file .env -f compose.yaml up -d cobalt
docker compose --env-file .env -f compose.yaml ps
docker exec orbis-cobalt-trial node -p \
  "require('/app/node_modules/.pnpm/youtubei.js@17.0.1/node_modules/youtubei.js/package.json').version"
```

The version must print `18.0.0`. That is what separates a working deployment from the one the first trial measured, and a rebuild that silently reused a stale layer would otherwise look identical. The published port must show the Tailscale address, not `0.0.0.0`:

```sh
ss -ltnp | grep ':9000 '
```

A `GET /` health request may be unauthenticated. Processing requests must not be. Do not treat a running container as a successful download test.

## Run the smoke check

Run the command from the repository root. Supply permitted fixtures and their approximate durations. The `source|url|seconds` value is repeated once per fixture. The command runs cases sequentially.

Keep the key out of the argument list. The environment variable is read by the process but never written to the report or standard output.

```bash
cd /path/to/orbis
set +x
# The prompt does not echo the key and does not put it in shell history.
read -r -s -p 'Cobalt API key: ' COBALT_API_KEY
printf '\n'
export COBALT_API_KEY
node scripts/smoke-cobalt.mjs \
  --endpoint 'http://100.77.187.21:9000/' \
  --api-key-env COBALT_API_KEY \
  --sample 'youtube|https://www.youtube.com/watch?v=<permitted-video-id>|<seconds>' \
  --sample 'soundcloud|https://soundcloud.com/<permitted-artist>/<permitted-track>|<seconds>' \
  --sample 'youtube|https://www.youtube.com/watch?v=<permitted-long-set-id>|<seconds-over-10800>' \
  --invalid-url 'https://example.invalid/not-a-supported-source' \
  --report "deploy/cobalt/cobalt-trial-$(date -u +%Y%m%dT%H%M%SZ).report.json"
unset COBALT_API_KEY
```

Replace the example endpoint with the address confirmed on Vanta. Never use a third-party music URL without permission. The long fixture must be greater than `10800` seconds and no greater than `21600` seconds.

The default bounds are a 20-minute download timeout, a five-minute processing timeout, a one-minute `ffprobe`/`ffmpeg` validation timeout, a 2 GiB output limit, a 60-second duration tolerance, and cancellation after 1 MiB for the interruption case. For an approved fixture, these can be overridden explicitly, for example:

```sh
node scripts/smoke-cobalt.mjs \
  ... \
  --download-timeout-ms 3600000 \
  --max-bytes 4294967296 \
  --duration-tolerance-seconds 120
```

Review every override before using it. The limits are safeguards, not proof that a longer or larger download is safe.

The command performs these checks:

1. Reads the instance info and verifies the configured API URL has the same origin as the supplied endpoint.
2. Verifies that the instance advertises only YouTube and SoundCloud.
3. Sends a valid processing request without a key and with a known-invalid key; both must be rejected.
4. Sends an unsupported URL with the valid key; Cobalt must return an error.
5. Sends each sample with the required JSON headers and `downloadMode: "audio"`, `audioFormat: "best"`, `localProcessing: "disabled"`, and `alwaysProxy: true`.
6. Accepts only a `tunnel` response. `error`, `picker`, `local-processing`, malformed responses, redirects, wrong-origin tunnels, and tunnel failures remain separate failures.
7. Streams each tunnel to a generated safe temporary filename, checks its metadata with `ffprobe`, decodes the complete file with `ffmpeg`, records the audio format, codec, byte count, and duration, and deletes the file.
8. Repeats the long sample and cancels its transfer after the configured byte bound. The case passes only when the partial file is removed.

The report contains no API key or tunnel URL. It records the host, UTC time, image reference and digests, non-secret configuration, redacted sample identity, expected and observed duration, format, byte count, completion time, and per-case outcome. Query strings are not recorded; SoundCloud private-link access segments are redacted.

Exit status is meaningful:

- `0`: all deployment, authentication, coverage, download, and interruption checks passed.
- `1`: a required check failed. Do not call this a successful trial.
- `2`: usage or setup input was invalid.

A run whose cases are `blocked` rather than `failed` also exits `1`. Read `overall` and `coverage` in the report rather than the exit code alone.

The report separates `checks`, `samples`, `interruption`, and `coverage`. A missing fixture or unavailable `ffprobe`/`ffmpeg` is `blocked`, not a pass. A YouTube failure does not hide a SoundCloud result, and vice versa.

## Observed behaviour on this deployment

These were measured on 2026-09-11 against the pinned image on Vanta. See [the trial evidence](cobalt-trial-evidence.md) for the numbers.

- Authentication rejections return HTTP 400 with an `error.api.auth.*` code, not 401 or 403. A request without a key returns `error.api.auth.key.missing` and a request with an unknown key returns `error.api.auth.key.not_found`. Both are refusals.
- YouTube drains a full download. With `VISIONOS` selected, Cobalt's reader works against these URLs unchanged: the `HEAD` it uses to learn the file size returns 200, and its 8 MiB ranges return 206. A YouTube audio `best` response arrives as Opus in a Matroska container, not as AAC, because the codec Cobalt selects changes with the client. Conversions to `mp3`, `ogg`, `opus`, and `wav` also complete and decode. Before this change, every client Cobalt could reach returned a URL YouTube served only a prefix of, and the reader turned that refusal into an empty tunnel.
- The first processing request after the container was created from a freshly pulled image returned `error.api.fetch.fail` for both sources. Later attempts, including immediately after recreating the container from the cached image, succeeded. Do not treat a first-attempt failure as a source verdict. Rerun with a fresh request.

## Restart, retest, and rollback

Restart only the trial service, then run a fresh smoke command. Do not reuse a tunnel URL; Cobalt tunnel URLs are temporary.

```sh
cd /path/to/orbis/deploy/cobalt
docker compose --env-file .env -f compose.yaml restart cobalt
docker compose --env-file .env -f compose.yaml ps
```

For rollback, stop and remove only the named Compose service. This does not remove the base image or unrelated containers. Remove the locally built image as well when the change is being reverted, since it exists only on this host:

```sh
docker compose --env-file .env -f compose.yaml down
docker image rm orbis-cobalt:11.7.1-youtubei18.0.0
```

Rolling back to the upstream image restores the empty YouTube download that [the decision record](../adr/0003-cobalt-youtube-client.md) describes.

After a rollback, verify that existing containers, port listeners, Caddy, and Tailscale routes match the pre-trial read-only check. Remove `keys.json`, `.env`, and sanitized reports only when the evidence has been retained elsewhere:

```sh
rm -f keys.json .env *.report.json
```

Do not remove shared Docker networks, prune images globally, or alter unrelated services.
