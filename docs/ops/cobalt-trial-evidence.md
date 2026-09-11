# Cobalt trial evidence and decision

This records the observed result of the private Cobalt trial on Vanta. It separates deployment health from per-source download results, as the ticket requires, and ends with a go or no-go recommendation.

> The YouTube failure this file records has since been diagnosed and fixed. Read [the follow-up](#follow-up-the-youtube-failure-diagnosed-and-fixed) before acting on the recommendation below, and [the decision record](../adr/0003-cobalt-youtube-client.md) for the change itself.

Keep the sanitized JSON reports out of Git. They are ignored at `deploy/cobalt/*.report.json`.

## Baseline and scope

| Item | Value |
| --- | --- |
| Implementation baseline recorded before remote work | `23d0c82`, as required by the execution gate |
| Host checkout at trial time | `1e10c55` on `main`, clean |
| Trial scope | Private deployment, operator smoke check, this evidence file |
| Application changes | None. No Orbis module, contract, schema, or desktop control changed. |
| Tooling changes | One defect fix in `scripts/smoke-cobalt.mjs`, recorded below |

The operator authorized the deployment on 2026-09-11, with the shared host running 12 unrelated containers.

## Deployment identity

| Item | Value |
| --- | --- |
| Container | `orbis-cobalt-trial` |
| Image | `ghcr.io/imputnet/cobalt:11@sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b` |
| Image index digest observed at pull time | `sha256:63186dd68afd57ce3bb1f62cc4c139f5fa95b9c3e87a3cf5c6e4c7a570523f62` |
| Reported version | 11.7.1, upstream commit `a636575b09de1fc55d9b8cd98cac88f5f2f16b42` |
| Port binding | `100.77.187.21:9000`, the Tailscale address only, confirmed with `ss -ltnp` |
| Filesystem and init | Read-only root filesystem, `init` enabled, `unless-stopped` restart policy |
| Advertised services | `["soundcloud", "youtube"]`, exact match to the required scope |
| Configured duration limit | 21600 seconds |
| Container count on the host | 12 before, 13 after |

The pinned index digest matched the value recorded in `docs/ops/cobalt-trial.md` before the pull, so the deployment is reproducible.

## Deployment health

All six checks passed on the final run.

| Check | Result | Observed |
| --- | --- | --- |
| Reachability | Passed | `GET /` returned the instance document |
| Reported API URL | Passed | `http://100.77.187.21:9000` |
| Service scope | Passed | `["soundcloud", "youtube"]` |
| Missing API key rejected | Passed | HTTP 400, `error.api.auth.key.missing` |
| Invalid API key rejected | Passed | HTTP 400, `error.api.auth.key.not_found` |
| Unsupported source rejected | Passed | HTTP 400, `error.api.link.invalid` |

Authentication works. A request without a key and a request with a wrong key are both refused, each with a distinct error code.

## Per-source download results

| Source | Fixture | Result | Observed |
| --- | --- | --- | --- |
| SoundCloud | `https://soundcloud.com/rinsefm/skin-on-skin-07-august-2026`, 6903 seconds expected | Passed | 110440068 bytes, mp3, 6902.49 seconds observed, 0.51 seconds from expected, complete decode, 13377 ms and 11276 ms over two runs |
| YouTube | Longest permitted seed link, 9181 seconds expected | Failed | Tunnel created with the correct filename, then served zero bytes |
| YouTube | Seed link, 1932 seconds expected | Failed | Tunnel created, zero bytes |
| Long set | None available | Blocked | No permitted fixture longer than three hours |

SoundCloud is proven end to end. A file of nearly two hours was retrieved, fully decoded, and matched its expected duration to within a second, in about thirteen seconds.

## Measurement against the trial budgets

The trial's performance gate measured processing wall time and output bytes per fixture, with an absolute budget because there is no earlier deployment to compare against.

| Measure | Budget | Observed | Result |
| --- | --- | --- | --- |
| Processing wall time, one fixture | Under 30 minutes | 13.4 seconds, then 11.3 seconds | Passed |
| Output bytes | Under 520 MiB | 105 MiB, identical across both runs | Passed |
| Run to run variance in wall time | Under 25 percent | 15.7 percent | Passed |

The parse of the downloaded file was identical across both runs, at 6902.491375 seconds and 110440068 bytes, so the transfer is deterministic. Only the wall time varies.

The gate applies to the one fixture that downloaded. YouTube produced no bytes, which the size budget cannot evaluate, so its failure is recorded as a functional result rather than a performance one.

## The YouTube failure

YouTube does not work on this deployment, and the failure is specific rather than general.

What was observed:

- The processing request succeeds. Cobalt returns a `tunnel` response with the correct audio filename, so the extractor resolves the video and selects a format.
- Fetching that tunnel returns HTTP 200 with `content-length: 0` and an empty body. The tunnel is created and then serves nothing.
- All four audio formats behave identically. `best`, `mp3`, `ogg`, and `wav` each produced a zero-byte tunnel, so the output format is not the cause.
- The container logs report no error, and its own readiness is fine. Its egress to both `youtube.com` and `soundcloud.com` succeeds.

This matches a known upstream condition rather than a configuration mistake. `docs/research/cobalt-self-hosting.md` already cited an open self-hosting report describing empty files and `file tunnel empty`, and advised diagnosing real failures before adding optional mechanisms.

The mechanisms that might resolve it are deliberately untouched. Cobalt supports optional cookies, a `YOUTUBE_SESSION_SERVER` pointed at a session generator, and HTTP proxies. Adding any of them requires account credentials or third-party infrastructure, which the ticket explicitly excludes unless it is a deliberate operator decision. None was added.

What is not established. This evidence does not prove that self-hosted Cobalt cannot download from YouTube, and it does not identify the exact upstream cause. It proves that this pinned deployment on this host, with no credentials and no proxy, returns empty YouTube audio while resolving metadata correctly.

## Blocked cases

The long-set case is blocked for a reason independent of Cobalt. The ticket requires a permitted fixture longer than three hours and no longer than six. The operator's permitted fixtures are the seed links, and their measured durations are 9181, 5580, 5560, 4682, and 1932 seconds. The longest is 9181 seconds, which is below the 10800 second threshold. The operator chose to defer this case rather than supply a longer permitted link.

The interrupted-transfer case depends on that same long fixture and is therefore also blocked. No partial file was produced or left behind, because the case never ran.

## The one transient failure, recorded honestly

The first smoke run, taken 36 seconds after the container was created from a freshly pulled image, failed differently. Both sources returned HTTP 400 with `error.api.fetch.fail`, and both authentication checks failed for the reason fixed below.

Every later attempt succeeded, including an attempt made one second after recreating the container from the already cached image. The same request body, headers, and credentials produced `error.api.fetch.fail` once and a working tunnel afterwards.

The failure therefore correlates with the first processing request after the image pull, not with source content, credentials, HTTP shape, or audio format. I did not isolate the internal cause, so treat it as unexplained. The practical consequence is that the first processing attempt after a fresh deployment should not be trusted as a source verdict, and the runbook's rerun guidance is what resolves it.

## Tooling defect found and fixed

`checkAuthorization` in `scripts/smoke-cobalt.mjs` accepted only HTTP 401 or 403 as proof that a key was rejected. Cobalt 11.7.1 returns HTTP 400 with an explicit `error.api.auth.*` code. A correctly refused request was therefore recorded as a failure, which would have hidden a working deployment behind a false negative.

The fix, in commit `8b6c25d`, accepts a response that carries a known authentication error code and records that code in the report.

The offline fake in `scripts/smoke-cobalt.test.mjs` answers with 401, which is why the suite never caught the mismatch. Aligning that fake with the real instance is worth doing before the next trial.

## Recommendation

Conditional go, with YouTube treated as not working.

Proceed with the download pipeline in ticket 11, because the mechanism is proven end to end for one source, the pipeline is source-agnostic, and the retry and recovery behaviour it needs is now better understood. Do not promise YouTube downloads.

Three conditions attach to the recommendation.

1. Ticket 11 must treat a source failure as a per-Set recoverable state, not a fatal error, because one of the two sources currently fails every time.
2. The first processing attempt after a fresh deployment must be retried before its failure is recorded as a source verdict.
3. YouTube requires a separate deliberate decision by the operator. The options are a session generator, cookies, or accepting YouTube as unsupported. That decision belongs to ticket 10 or a new ticket, not to this trial.

The audio format decision can proceed now. SoundCloud returned complete mp3 audio that decoded fully and matched its duration, so mp3 is a working Apple-compatible candidate. The AVFoundation measurements in `docs/plans/native-clients-program.md` cover the rest.

## Untested cases

- YouTube downloads from a self-hosted Cobalt, with and without session credentials.
- Any fixture longer than three hours.
- Interrupted-transfer cleanup.
- Behaviour over a long period, since this trial ran within one hour.
- Whether the pinned digest still resolves upstream at a later date.

## Follow-up: the YouTube failure diagnosed and fixed

The operator authorized a further investigation of the empty YouTube tunnel, which [Decide how Orbis handles YouTube downloads](https://github.com/ParthMmm/orbis/issues/18) listed as its fourth option. It ran on the same host against the same base image, and this section records what the first run could not: the cause, and the change that fixes it.

### The cause

The failure needs three facts together, and only the last of them is about YouTube's restrictions.

1. Cobalt routes `youtube` through `handleChunkedStream` in `api/src/stream/internal.js`, which learns the file size from a bodyless `HEAD`. When that `HEAD` is refused, the handler calls `cleanup()`, which ends the response with status 200, no body, and no log line. That is the empty tunnel, and it is why the container looked healthy while every download was zero bytes.
2. The `HEAD` is refused because YouTube returns restricted stream URLs to the client Cobalt asks for. Measured on the deployment for the `IOS` client and itag 140:

| Request                       | Result |
| ----------------------------- | ------ |
| `HEAD`, no `Range`            | 403    |
| No `Range` header at all      | 403    |
| `bytes=0-0`, `bytes=100-1023` | 206    |
| `bytes=0-1048576`             | 206    |
| `bytes=1048577-2097152`       | 403    |
| `bytes=5000000-5001023`       | 403    |
| `bytes=0-`, the whole file    | 403    |

Only roughly the first MiB is reachable, so no chunk sequence can reassemble a file. The same URL returned the same 403 from the Vanta host and from inside the container, and from both an IPv4-bound and an IPv6-bound instance of it, so neither the network path nor the address explains it.

3. Every client the vendored `youtubei.js` 17.0.1 can reach behaves the same. `IOS`, `MWEB`, `ANDROID_VR`, and `TV_SIMPLY` each returned 403 for a plain request and for a deep range, and `WEB` and `ANDROID` returned no usable URL at all.

### The change

`youtubei.js` 18.0.0 is the first release with the `VISIONOS` client, whose URLs Cobalt's reader handles without modification:

|  | `IOS` on 17.0.1 | `VISIONOS` on 18.0.0 |
| --- | --- | --- |
| The `HEAD` Cobalt uses to size the file | 403 | 200 with the correct `content-length` |
| An 8 MiB range | 403 | 206 with all 8,388,609 bytes |
| A range deep inside the file | 403 | 206 |

`deploy/cobalt/Dockerfile` builds one derived image: the same base pinned by digest, with the vendored library replaced by 18.0.0, selected with `CUSTOM_INNERTUBE_CLIENT=VISIONOS`. No Cobalt source changed, and no cookie, session server, or proxy was added.

### Result

Run with `scripts/smoke-cobalt.mjs` from the repository root on Vanta, against the deployed endpoint.

| Case | Result | Observed |
| --- | --- | --- |
| Reachability, API URL, service scope | Passed | Services `["soundcloud", "youtube"]` |
| Missing key, invalid key, unsupported link | Passed | `error.api.auth.key.missing`, `error.api.auth.key.not_found`, `error.api.link.invalid`, each HTTP 400 |
| YouTube | Passed | 10,258,925 bytes, Opus in Matroska, 634.601 seconds against 634 expected, complete decode, 2,460 ms |
| SoundCloud | Passed | 110,440,068 bytes, mp3, 6902.49 seconds against 6903 expected, complete decode, 10,272 ms |
| Long set | Blocked | No permitted fixture over three hours, and no partial file to clean up. Unchanged from the first run. |

The YouTube case used Big Buck Bunny (Blender Foundation, CC-BY) instead of the operator's seed links, because those links are recorded only in redacted form. The two `best` measurements differ in container as well as source: with `VISIONOS`, `audioFormat: "best"` yields Opus in Matroska rather than AAC in MP4, which is a change to the input of [Select an Apple-compatible Cobalt output](https://github.com/ParthMmm/orbis/issues/10).

### What this corrects

- The three mechanisms the trial named as the way forward, cookies, a session server, and a proxy, do not address the cause. The refusal follows the URL, not the requester.
- The session-server option is broken independently of this failure. Cobalt 11.7.1 POSTs `/get_pot`, while `imputnet/yt-session-generator` serves `/token`, so a current generator does not answer the call Cobalt makes. A generator started on Vanta during this investigation never minted a token, failing every attempt with `timeout waiting for outgoing API request`.
- The recommendation above, that YouTube be treated as not working, no longer holds. It is superseded by [the decision record](../adr/0003-cobalt-youtube-client.md).

### A diagnostic trap worth recording

`ffmpeg-static` in this container cannot resolve an external hostname, so running it directly against a googlevideo URL fails with `Failed to resolve hostname ... System error`. That is a property of the static binary and says nothing about the deployment, because Cobalt never hands it an external URL: `wrapStream` rewrites the media URL to an internal tunnel on `127.0.0.1` first. An offline diagnosis that passes the raw URL to ffmpeg will find a fault that the service does not have.
