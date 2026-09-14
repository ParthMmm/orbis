# Audio downloads and streaming

Tap Download on a Set and Vanta fetches the audio through the private Cobalt deployment, keeps the file beside the library database, and the apps stream it with seek. Stream-only: nothing is stored on the device.

## States

The existing `downloadState` carries the whole flow: `none → queued → downloading → ready`, with `failed` and `canceled` as terminal states a new request restarts. `POST` is idempotent: requesting a `ready` Set answers ready, requesting a `queued`/`downloading` one answers its current state. `DELETE` cancels in flight, removes any partial file, and returns the Set to `none`. Finished downloads are kept; there is no eviction.

## Server

Files live under `ORBIS_DATA_DIR/audio/<setId>.<ext>`, outside the checkout next to `library.sqlite`. The output follows the #10 decision record (`docs/research/cobalt-audio-format.md`): request `best` with no `audioBitrate`, then decide the container from `ffprobe`, never the filename. Matroska/WebM (YouTube Opus) is remuxed bit-exact with `ffmpeg -i <file> -map 0:a:0 -c:a copy <setId>.ogg` and stored as `.ogg`; anything already Apple-playable (SoundCloud MP3) is stored as received. The worker records the ffprobe-measured duration and treats player-reported Ogg duration as approximate. Every Cobalt error shape lands the Set in `failed`; the worker never dies on a bad Cobalt response. Bodies stream to disk behind a 2 GiB bound because converted tunnels carry no content length.

- `POST /sets/:id/audio/download` → the Set (`202` when newly queued, `200` answering the current state). `404` for an unknown Set, `503` when the Cobalt integration is unconfigured. Every stored source is one Cobalt handles, so a source Cobalt rejects lands the Set in `failed` rather than failing the request.
- `GET /sets/:id/audio/state` → `{ state, bytesReceived, bytesTotal | null, format | null }` for progress.
- `GET /sets/:id/audio` → the file with `Accept-Ranges: bytes`, `206` partial responses, and the format's content type. `404` unless the state is `ready`. AVPlayer seeks with byte ranges on every read, so a response without range support is a defect, not a fallback.
- `DELETE /sets/:id/audio/download` → cancel and clean up, back to `none`.

The worker is an in-process Effect fiber, one download at a time: it claims a `queued` row, marks `downloading`, streams Cobalt's tunnel URL to the file while updating byte counts, then marks `ready` with bytes and format, or `failed` with the reason logged server-side only. All four routes require device authentication like the rest of the library.

Configuration (environment, via the existing systemd drop-in convention):

- `ORBIS_COBALT_URL` — where Cobalt answers (Vanta loopback or tailnet address; the Compose file is unchanged).
- `ORBIS_COBALT_API_KEY` — the Cobalt API key. Never logged, never returned.

## Shared contract

`packages/contracts` gains the audio state shape and the four routes. The existing `downloadState`, `retainedAudioBytes`, and `retainedAudioFormat` fields are what the apps render; the worker is the only writer of the file fields.

## Apps (iOS and macOS)

- Set detail shows Download when the state is `none`, `failed`, or `canceled`; progress with Cancel while `queued`/`downloading` (poll the state route about once a second); Play when `ready`.
- Playback streams `GET /sets/:id/audio` through AVPlayer with the device token in `AVURLAssetHTTPHeaderFieldsKey`. Play/pause, seek slider, buffering and error states, title in Now Playing, and remote-command play/pause. No offline copy, no position sync in this slice.
- Playback eligibility is all-or-nothing: `.playback` session category with no `.mixWithOthers`, `audio` in `UIBackgroundModes`, session activated before play, and at least one remote-command target registered and enabled — missing any one silently kills Lock Screen and Control Center. Publish elapsed time and `playbackRate` (never `playbackState`, never on a timer) at play, pause, seek, and track change only. Handle interruptions (pause on began, reactivate on ended with resume) and headphone route removal (pause). Artwork waits for a later slice; title-only metadata.
- Tests use the existing stub-session patterns plus a fake audio source; no test hits Cobalt or Vanta.

## Out of scope

Offline device copies, retention/eviction, position sync and listening statistics, playlist-level download, artwork in Now Playing, transcoding (unless the #10 decision requires it), and any Cobalt deployment change.

## Verification

`bun run check:force` with worker tests against a stub Cobalt HTTP server (not the live one) plus byte-range assertions; `swift test` for the OrbisDesign package and `node scripts/native-lanes.mjs --unit` for the app. Final acceptance is a live end-to-end on Vanta: download a real Set, confirm `ready` with the decided format, and stream with seeks on both platforms.
