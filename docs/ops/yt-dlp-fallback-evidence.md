# yt-dlp fallback trial: evidence and decision

The Cobalt trial proved one source and failed the other. It retrieved a 1.9 hour SoundCloud track in about twelve seconds, and returned zero bytes for every YouTube request. This records a private trial of yt-dlp on Vanta as the YouTube path, run against the same host, the same Source Links, and the same measurement shape.

It supplies the audio half of [Decide how Orbis handles YouTube downloads](https://github.com/ParthMmm/orbis/issues/18), the measured format input for [Select an Apple-compatible Cobalt output](https://github.com/ParthMmm/orbis/issues/10), and the backend design for [Download one Set end to end](https://github.com/ParthMmm/orbis/issues/11).

## Scope and baseline

| Item | Value |
| --- | --- |
| Host | Vanta, Linux x86_64, 12 logical CPUs, 752 GiB free on `/` |
| Date | 2026-09-11 |
| Repository baseline | `460c39b` on `main` |
| Fixtures | The five initial Source Links recorded in [Build native Orbis clients and Vanta playback](https://github.com/ParthMmm/orbis/issues/3), one operator-supplied link, and the SoundCloud reference track from the Cobalt trial |
| Application changes | None. No server, contract, schema, desktop, or native file changed. |
| Host changes | Per-user tools only. No system package, container, or service was added, changed, or restarted. |

The Cobalt container from the earlier trial stayed up throughout and was not touched.

## Setup on Vanta

| Component          | Version    | Install                             |
| ------------------ | ---------- | ----------------------------------- |
| yt-dlp             | 2026.08.19 | `uv tool install 'yt-dlp[default]'` |
| yt-dlp-ejs         | 0.8.0      | Required by the `[default]` extra   |
| Deno               | 2.9.6      | `uv tool install deno`              |
| FFmpeg and FFprobe | 7.1.5      | Already present                     |

Two setup facts cost time and are worth recording.

**The bare wheel is not enough.** YouTube needs an external JavaScript runtime and the EJS challenge solver scripts. Without them every extraction fails with `Signature solving failed`, `n challenge solving failed`, and `Only images are available for download`. The `[default]` extra carries `yt-dlp-ejs`; the plain `yt-dlp` package does not.

**Deno is the runtime to install.** yt-dlp enables Deno by default and detected it immediately as `JS runtimes: deno-2.9.6`. Node is not auto-detected and needs `--js-runtimes node`; Bun support is deprecated upstream.

## Per-fixture results

Every download used `-f bestaudio`, remuxed to Ogg Opus, on Vanta, without cookies.

| Source Link | Expected duration | Observed | Stored bytes | Bitrate | Import wall time | Decode |
| --- | --- | --- | --- | --- | --- | --- |
| `tPEMP9oYxTo` (seed 1) | 9181 s | 9181.21 s | 146,018,267 | 127 kbps | 9.0 s | Complete |
| `_r-mWYZQ660` (seed 2) | 1932 s | 1931.49 s | 28,123,452 | 116 kbps | 3.6 s | Complete |
| `o1WMySEaJ0I` (seed 3) | 5580 s | 5579.69 s | 88,882,485 | 127 kbps | 6.6 s | Complete |
| `fT3RuwXAcoE` (seed 4) | 5560 s | 5560.07 s | 89,604,970 | 128 kbps | 7.7 s | Complete |
| `oUFlIj_LyPI` (seed 5) | 4682 s | 4681.69 s | 70,885,213 | 121 kbps | 5.6 s | Complete |
| `KrOqm7Ng7VY` (operator) | 3457 s | 3457.19 s | 55,197,896 | 127 kbps | 5.0 s | Complete |

Six fixtures, six complete files. Every one resolved format 251, Opus at 129 kbps and 48 kHz. Every observed duration is within 0.51 seconds of the expected value, inside the smoke check's 60 second tolerance. The Cobalt deployment returned zero bytes for the same YouTube fixtures.

The SoundCloud reference track behaves the other way round, and this is the first sign that the two backends should not be treated as interchangeable:

| Backend and setting | Bytes | Stored codec | Wall time |
| --- | --- | --- | --- |
| Cobalt 11.7.1, `audioFormat: best` | 110,440,068 | mp3, 128 kbps | 12 to 13 s |
| yt-dlp, `bestaudio` as received | 139,241,522 | AAC, 161 kbps in m4a | 23.7 s |
| yt-dlp, forced to Ogg Opus | 82,455,410 | Opus, 95 kbps | 85.9 s |

SoundCloud serves AAC at 160 kbps as its best stream. Asking yt-dlp to produce Opus from it is a lossy transcode that discards quality and takes four times as long, so the stored format must follow the source codec rather than a fixed target. Cobalt's own mp3 is also a transcode, at a lower source bitrate than yt-dlp reaches.

## Stored format comparison

The long fixture, measured four ways on Vanta.

| Stored as | Source format | Conversion | Bytes | Bitrate | Wall time |
| --- | --- | --- | --- | --- | --- |
| Ogg Opus | 251 | Container only | 146,018,267 | 127 kbps | 8.4 s |
| WebM Opus | 251 | None | 148,091,397 | 129 kbps | 8.0 s |
| m4a AAC | 140 | None | 148,482,399 | 129 kbps | 10.7 s |
| mp3, `-q:a 0` | 251 | Lossy to lossy | 300,119,132 | 261 kbps | 143.7 s |
| wav | 251 | Lossy to PCM | About 1.6 GB | 1411 kbps | Not measured |

The remux is the smallest of the four working candidates and the only one that neither re-encodes nor leaves the audio in a container Apple platforms reject.

## Audio quality findings

**The ceiling is 129 kbps Opus, and YouTube sets it.** For these uploads YouTube encodes one audio ladder: 139 at 49 kbps, 249 at 49 kbps, 250 at 65 kbps, 140 at 129 kbps, and 251 at 129 kbps. There is no higher tier for user uploads, so no downloader can retrieve one.

**YouTube Premium changes nothing here.** With the operator's Premium cookies the format table is identical to the table without them: 44 rows each, no row unique to either side, and no 141 (AAC 256) or 774 (Opus 256). Those tiers belong to licensed YouTube Music catalog tracks, and yt-dlp has had no access to them since release 2025.08.11 ([yt-dlp#14208](https://github.com/yt-dlp/yt-dlp/issues/14208)). The Premium entitlement does expose enhanced-bitrate video as format 616, or its https twin 356, where YouTube generated that rendition. None of these fixtures has one, and video is outside the Retained Audio model.

**A remux does not touch the audio.** The long fixture remuxed to Ogg Opus decodes to PCM md5 `857136d694d4d52c8122450b13bcbd36`, identical to the raw WebM stream and identical again to a download taken without cookies. An mp3 transcode of the same audio costs twice the bytes and adds a second lossy generation.

## The stored-format decision

Keep the source codec. Change the container only when Apple platforms require it. Never convert between lossy codecs.

| Source stream | Stored as | Conversion | Reason |
| --- | --- | --- | --- |
| Opus in WebM (YouTube format 251) | Ogg Opus | Remux | AVFoundation rejects WebM with error -11828, and plays and seeks Ogg Opus |
| AAC in HLS or MP4 (SoundCloud 160k, YouTube format 140) | m4a | Remux or keep | The native AVFoundation path, with no re-encode |

MP3, WAV, and any cross-codec transcode are rejected. The measured cost of the mp3 path is 300 MB against 146 MB for the same audio, plus a generation of quality loss, plus 143.7 seconds of processor time against 8.4 seconds.

## Cookies are not required

Public content downloads without credentials. The evidence is threefold.

- A partial download of the long fixture produced identical bytes with and without cookies: 941,968 bytes for the same 60 seconds.
- The complete no-cookie download of the long fixture decodes to PCM md5 `857136d694d4d52c8122450b13bcbd36`, the same value the cookie download produced.
- The full format tables are identical with and without cookies, 44 rows each.

The boundary is untested: age-restricted, private, members-only, region-limited, and bot-checked content were not exercised. For those, the fallback should accept an optional cookies path from configuration, used only when extraction fails without one, never stored in the repository, and never written to a log. The pipeline must not require cookies, because requiring them ties every download to a personal account and adds a credential that expires.

## Serving rules

The stored file is served as it is. No transcode happens at play time.

- Byte ranges are mandatory, not an optimisation. The media prototype recorded 16 requests during one playback session and every one carried a `Range` header, with no full-body request. Answer with `206`, `Content-Range`, `Content-Length`, and `Accept-Ranges`, and support `HEAD`.
- Content type follows the stored container: `audio/ogg` for Ogg Opus, `audio/mp4` for m4a.
- Duration and size must come from the database or FFprobe. AVFoundation reports `estimatedDataRate` as 0 for Opus.
- Allow overlapping range requests. AVFoundation issues them concurrently.
- Never hand a Cobalt tunnel URL to a client. Cobalt tunnels expire in 90 seconds and the download must be materialised on Vanta first.
- A file never changes once written, so `Cache-Control: private` with a long lifetime and an `ETag` is safe.

## The fallback design for ticket 11

One narrow source interface, two backends, and a recorded winner.

1. `apps/server/src/audio-source.ts` holds the seam: `fetch(set) -> Stream<Uint8Array, SourceError>` with byte, duration, and timeout bounds. Its failures are typed so the worker can tell "this backend produced no usable output" from "this link is unsupported". Only the first is worth another backend; the second is terminal.
2. `apps/server/src/cobalt.ts` remains the Cobalt client, unchanged in shape.
3. `apps/server/src/ytdlp.ts` becomes the second backend. It spawns the pinned binary with a fixed argument list, never through a shell, writes to a temporary path inside the managed media directory, streams to disk, and deletes partial output on every failure path.
4. The worker tries the preferred backend first and the other on a retryable failure, then records which backend produced the file on the download row. Preference follows the evidence: YouTube first to yt-dlp, SoundCloud first to Cobalt. Each is proven on its source and the other is the safety net.

Bounds and safety.

- Configuration carries `YTDLP_BIN` as an absolute path and an optional cookies path. Never resolve the binary through `PATH`, and never build an argument list from a URL and a shell string.
- The size, duration, and timeout bounds apply identically to both backends.
- Record the yt-dlp version with the job or in its log, so a broken extractor is identifiable from the failure alone.

The maintenance cost is real and belongs in the decision. YouTube extractors break often, which is why the fallback needs a recurring task: upgrade yt-dlp and re-run one smoke fixture. Pinning a version is not viable for YouTube. Pin the binary path, not the version.

## Untested cases

- Age-restricted, private, members-only, region-limited, and bot-checked content, with and without cookies.
- Playback of Ogg Opus on real iOS hardware, and over Tailscale rather than loopback. [Play Retained Audio with system media controls](https://github.com/ParthMmm/orbis/issues/13) owns both.
- Rate limits and long-run behaviour. Fewer than ten downloads were taken within one hour on one host.
- SoundCloud private links and playlists. Orbis still accepts direct public track URLs only.
- Whether the pinned Cobalt digest still resolves upstream at a later date.

## Evidence hygiene

The operator's YouTube cookies are a credential. They were copied to `/home/parth/.config/orbis/youtube-cookies.txt` with mode `0600`, were never printed, and were never committed. Every downloaded media file was deleted after it was measured, leaving only logs and result files under `/tmp/orbis-ytdlp-trial`. The cookie file can be deleted now: the trial shows it is not needed for these fixtures.

## Reproduction

```sh
ssh vanta bash -s <<'REMOTE'
export PATH="$HOME/.local/bin:$PATH"
uv tool install 'yt-dlp[default]'
uv tool install deno
yt-dlp --version

work=$(mktemp -d)
for id in tPEMP9oYxTo _r-mWYZQ660 o1WMySEaJ0I fT3RuwXAcoE oUFlIj_LyPI; do
  yt-dlp --no-playlist --no-warnings -f bestaudio \
    --extract-audio --audio-format opus \
    -o "$work/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=$id"
done
ffprobe -v error -show_entries format=duration,format_name \
  -show_entries stream=codec_name -of default=nw=1 "$work"/*.opus
rm -rf "$work"
REMOTE
```
