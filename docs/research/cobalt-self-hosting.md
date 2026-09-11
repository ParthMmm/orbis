# Cobalt on Vanta

Checked: 2026-09-10, and updated 2026-09-11 after the deployment was tested. The original check was a feasibility note, not a deployment or download test; the update records what testing changed.

## Conclusion

Yes: Cobalt is the private download service on Vanta, and it downloads from both YouTube and SoundCloud. The original conclusion is kept below because it governed the trial that produced that result.

> Yes: Cobalt is a candidate for a private download service on Vanta. Upstream recommends self-hosting its API and documents audio downloads for both YouTube and SoundCloud. However, documented support does not establish that YouTube downloads work from Vanta today. Test representative links before making it the only download backend. [1][2][6]

The test was run, and YouTube did not work. What testing added is the reason, which was not one of the mechanisms this note assumed: YouTube serves the client Cobalt asked with a stream URL it will only serve a prefix of, and Cobalt's reader turned that refusal into an empty file without logging anything. Both sources now download, with no cookie, proxy, or session server. See [the decision record](../adr/0003-cobalt-youtube-client.md) for the change and [the trial evidence](../ops/cobalt-trial-evidence.md) for the measurements.

## Hosting

- Upstream recommends Docker Compose. Its example uses `ghcr.io/imputnet/cobalt:11`, a read-only container filesystem, and port 9000. Only `API_URL` is mandatory; it must be reachable by the process consuming the returned tunnel URLs. A separate frontend is not needed for an app integration. [1][2][3][4]
- Require API keys with `API_KEY_URL=file:///keys.json` and `API_AUTH_REQUIRED=1`; mount the key file read-only. Requests use `Authorization: Api-Key <key>`. Merely configuring keys does not require authentication. [2][5]
- Proposed setup: bind the host port only to loopback or Vanta's Tailscale address, with private HTTPS if accessed across devices. Do not use a public Funnel or an all-interface port mapping. Keep the key in the download worker, not the renderer.
- The example includes Watchtower and a Docker socket mount. For a first trial, omit automatic updates and pin the tested image digest. This is a recommendation, not an upstream requirement. [3]
- No upstream CPU/RAM minimum was established. Actual load depends on concurrency and whether FFmpeg must transcode. A single-instance trial does not need the documented multi-instance Redis setup. [4]

### Vanta observations

Read-only SSH checks found Linux x86_64, 12 logical CPUs, 31 GiB RAM (about 25 GiB available), roughly 754 GiB available on `/`, Docker 29.7.2, and Docker Compose v5.4.0. No running Cobalt container or listener on port 9000 was observed. FFmpeg is installed. These observations suggest ample room for a small audio-download trial; they are not load-test results.

Vanta already has a public Tailscale Funnel for an unrelated service. A Cobalt deployment must stay separate from that public route. No remote files, containers, or services were changed.

## API and storage

The proposed worker sends `POST /` with `Accept: application/json`, `Content-Type: application/json`, the API key, and a body such as: [2]

```json
{
  "url": "<saved source URL>",
  "downloadMode": "audio",
  "audioFormat": "best",
  "localProcessing": "disabled",
  "alwaysProxy": true
}
```

`audioFormat: "best"` is a proposed default; test the returned format against our playback clients before settling it. The API also supports MP3, Opus, Ogg, and WAV. [2]

That test is done for YouTube and the default does not survive it. `best` returns Opus in a Matroska container for YouTube, which AVFoundation does not play, while MP3, Opus, and Ogg all convert and decode. SoundCloud is unaffected and still returns MP3 for `best`. The choice is open in [Select an Apple-compatible Cobalt output](https://github.com/ParthMmm/orbis/issues/10). [11]

Cobalt returns JSON first, not the finished file. The worker handles its response status and consumes the returned file URL. The API distinguishes `tunnel`, `redirect`, `local-processing`, `picker`, and `error`; do not assume every successful HTTP response contains audio. With `alwaysProxy`, we request a Cobalt tunnel rather than a direct upstream URL. [2]

Cobalt does not retain downloaded media. Orbis still needs a download queue/worker, cancellation, retry policy, partial-file cleanup, persistent files, and download state. Fetch temporary tunnel URLs promptly rather than saving them as permanent playback URLs; the default tunnel lifespan is 90 seconds. [4][7]

The default media duration limit is **10,800 seconds (three hours)**. Raise `DURATION_LIMIT` deliberately if longer DJ sets are in scope. [4]

## Service support and limits

- **SoundCloud:** upstream lists audio, metadata, rich filenames, and private-link support. Orbis currently accepts only direct public track URLs, so Cobalt's broader support does not automatically change our input rules. [1][9]
- **YouTube:** works, and the first deployment's failure is explained. Upstream lists video, music, Shorts, and audio downloads and the extractor is present, but the client library Cobalt 11.7.1 vendors, `youtubei.js` 17.0.1, can only reach clients whose stream URLs YouTube serves a prefix of: a request with no `Range` header, or one reaching past roughly the first MiB, is refused with 403, so no chunk sequence can assemble a file. Cobalt then hides the refusal, because the reader that sizes a YouTube download ends the response with status 200 and no body when its sizing request is refused. That is the `file tunnel empty` report in source 6, reproduced. The library's 18.0.0 release adds the `VISIONOS` client, whose URLs the same reader handles unchanged. [6][8]
- Upstream also exposes optional cookies, `YOUTUBE_SESSION_SERVER` for a `yt-session-generator` instance, and HTTP(S) proxies. Measured against this deployment, none of the three addresses that failure, because the refusal follows the URL and not the requester: it reproduced from two different hosts and over both IPv4 and IPv6. The session-server route is broken as documented as well, since Cobalt 11.7.1 requests `/get_pot` while the current generator serves `/token`, and a generator started on Vanta never minted a token at all. Treat these as mechanisms for restricted content, not as the fix for empty files. [3][4][8]
- Cobalt describes its scope as downloading freely accessible content, not bypassing paywalls or DRM. Download only content we have permission to retain. [7]

## Fit with Orbis

The current app saves YouTube/SoundCloud links, titles, and tags; it has no download or playback implementation. Its API binds to loopback and explicitly must not be published before identity and authorization exist. A private Cobalt service does not make the current Orbis server safe to expose. [9]

That first step is done. Both sources were verified against the deployed instance with `scripts/smoke-cobalt.mjs`, including complete and nonempty files, expected duration, and full decode, and the results are in [the trial evidence](../ops/cobalt-trial-evidence.md). The long-set and cancellation cases remain blocked for want of a permitted fixture over three hours. Keep the Cobalt integration behind a small backend interface so a service outage does not require changes throughout the app.

## License

The API uses AGPL-3.0. Section 13 requires a source offer to remote users of a modified version. The trial ran Cobalt unmodified, and the deployed service no longer does: `deploy/cobalt/Dockerfile` pins the upstream image by digest and replaces one vendored library, so the running service is a modified version. Keep that modification in this repository, which is where the Dockerfile and the build argument that pins the library already live, and keep Cobalt's own code out of Orbis. This is an engineering boundary, not a legal conclusion about licensing the wider app; review obligations before modifying or redistributing it further. [1][10]

## Sources

1. [API README and supported services](https://github.com/imputnet/cobalt/blob/main/api/README.md)
2. [API documentation](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
3. [Compose example](https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml) and [hosting guide](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
4. [Environment variables](https://github.com/imputnet/cobalt/blob/main/docs/api-env-variables.md)
5. [API key protection](https://github.com/imputnet/cobalt/blob/main/docs/protect-an-instance.md)
6. [Self-hosted YouTube empty-file report, issue #1475](https://github.com/imputnet/cobalt/issues/1475) — reproduced on Vanta, with the cause and the fix recorded in source 11.
7. [Root README: streaming and scope](https://github.com/imputnet/cobalt/blob/main/README.md)
8. [YouTube extractor](https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/youtube.js)
9. Local checkout: `README.md`, `apps/server/src/index.ts`, `apps/server/src/source-url.ts`, `apps/server/src/library.ts`, and `packages/contracts/src/index.ts` (existing uncommitted state on `main`).
10. [API license](https://github.com/imputnet/cobalt/blob/main/api/LICENSE)
11. [ADR 0003: run a derived Cobalt image whose client returns YouTube stream URLs that work](../adr/0003-cobalt-youtube-client.md), [trial evidence](../ops/cobalt-trial-evidence.md), and [the deployment runbook](../ops/cobalt-trial.md) (this repository, added after the deployment test).
