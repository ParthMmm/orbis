# Cobalt on Vanta

Checked: 2026-09-10. This is a feasibility note, not a deployment or download test.

## Conclusion

Yes: Cobalt is a candidate for a private download service on Vanta. Upstream recommends self-hosting its API and documents audio downloads for both YouTube and SoundCloud. However, documented support does not establish that YouTube downloads work from Vanta today. Test representative links before making it the only download backend. [1][2][6]

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

Cobalt returns JSON first, not the finished file. The worker handles its response status and consumes the returned file URL. The API distinguishes `tunnel`, `redirect`, `local-processing`, `picker`, and `error`; do not assume every successful HTTP response contains audio. With `alwaysProxy`, we request a Cobalt tunnel rather than a direct upstream URL. [2]

Cobalt does not retain downloaded media. Orbis still needs a download queue/worker, cancellation, retry policy, partial-file cleanup, persistent files, and download state. Fetch temporary tunnel URLs promptly rather than saving them as permanent playback URLs; the default tunnel lifespan is 90 seconds. [4][7]

The default media duration limit is **10,800 seconds (three hours)**. Raise `DURATION_LIMIT` deliberately if longer DJ sets are in scope. [4]

## Service support and limits

- **SoundCloud:** upstream lists audio, metadata, rich filenames, and private-link support. Orbis currently accepts only direct public track URLs, so Cobalt's broader support does not automatically change our input rules. [1][9]
- **YouTube:** upstream still lists video, music, Shorts, and audio downloads, and the extractor remains in the repository. But an open self-hosting report describes empty files and `file tunnel empty`; treat it as evidence of possible failure, not proof that all deployments fail. [1][6][8]
- Upstream exposes optional cookies and `YOUTUBE_SESSION_SERVER` for a `yt-session-generator` instance that supplies session tokens. HTTP(S) proxies are also configurable. These are available mechanisms, not guaranteed fixes or proven requirements for Vanta. Start with a minimal private setup and diagnose actual test failures before adding them. [3][4][8]
- Cobalt describes its scope as downloading freely accessible content, not bypassing paywalls or DRM. Download only content we have permission to retain. [7]

## Fit with Orbis

The current app saves YouTube/SoundCloud links, titles, and tags; it has no download or playback implementation. Its API binds to loopback and explicitly must not be published before identity and authorization exist. A private Cobalt service does not make the current Orbis server safe to expose. [9]

Recommended first step: deploy only the private Cobalt API, then verify a few permitted YouTube and SoundCloud links, including a long set. Check complete, nonempty files, expected duration, playable audio, failures, and cancellation. Only then implement the download worker and choose where retained files live. Keep the Cobalt integration behind a small backend interface so a service outage does not require changes throughout the app.

## License

The API uses AGPL-3.0. Section 13 requires a source offer to remote users of a modified version. Keep Cobalt as a separate, unmodified service for the trial; do not copy its code into Orbis. This is an engineering boundary, not a legal conclusion about licensing the wider app; review obligations before modifying or redistributing it. [1][10]

## Sources

1. [API README and supported services](https://github.com/imputnet/cobalt/blob/main/api/README.md)
2. [API documentation](https://github.com/imputnet/cobalt/blob/main/docs/api.md)
3. [Compose example](https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml) and [hosting guide](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)
4. [Environment variables](https://github.com/imputnet/cobalt/blob/main/docs/api-env-variables.md)
5. [API key protection](https://github.com/imputnet/cobalt/blob/main/docs/protect-an-instance.md)
6. [Self-hosted YouTube empty-file report, issue #1475](https://github.com/imputnet/cobalt/issues/1475) — open when checked; user report, not a reproduced Vanta test.
7. [Root README: streaming and scope](https://github.com/imputnet/cobalt/blob/main/README.md)
8. [YouTube extractor](https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/youtube.js)
9. Local checkout: `README.md`, `apps/server/src/index.ts`, `apps/server/src/source-url.ts`, `apps/server/src/library.ts`, and `packages/contracts/src/index.ts` (existing uncommitted state on `main`).
10. [API license](https://github.com/imputnet/cobalt/blob/main/api/LICENSE)
