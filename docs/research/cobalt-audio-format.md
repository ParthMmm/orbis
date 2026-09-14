# Cobalt audio output for Apple clients

Checked: 2026-09-14, against the deployed Cobalt trial on Vanta and AVFoundation on this Mac. Every number in this file is either cited to a source below or was measured for this record; the commands that produced each measurement are named.

## Question

Which single Cobalt audio output should Orbis request and store, when the owner's order of preference is: best quality first, stream-only delivery, keep everything, from both YouTube and SoundCloud, stored on Vanta and streamed to Apple clients that decode with AVFoundation and seek by byte range over multi-hour Sets?

Answer in one line: request `audioFormat: "best"` and never set `audioBitrate`, then fix the container at store time only when the delivered container is Matroska or WebM, using a `ffmpeg -c:a copy` remux to Ogg Opus. SoundCloud `best` needs no remux at all. The details and the rejected alternatives follow.

## How the measurement was made

The private deployment measured is the one [the trial runbook](../ops/cobalt-trial.md) describes: `orbis-cobalt-trial`, image `orbis-cobalt:11.7.1-youtubei18.0.0`, `sha256:814f3e02…`, `CUSTOM_INNERTUBE_CLIENT=VISIONOS`, API key required, YouTube and SoundCloud only, `DURATION_LIMIT=21600`. Its local image ID and creation time were re-read from Docker before the run. [11]

Fixtures, both permitted and public:

- YouTube: Big Buck Bunny (Blender Foundation, CC BY), `https://www.youtube.com/watch?v=YE7VzlLtp-4`. Its own decoded duration measured 596.501 s. This is a different upload from the 634 s fixture [the trial evidence](../ops/cobalt-trial-evidence.md) used, so its `best` numbers are not directly comparable to the trial's.
- SoundCloud: the Set the trial used, `https://soundcloud.com/rinsefm/skin-on-skin-07-august-2026`, 6903 s expected, 6902.49 s measured. No permitted fixture over three hours exists; this Set is the longest at 1 h 55 m. The over-three-hour case stays blocked, as it was in the trial. [11]

Tooling: `scripts/smoke-cobalt.mjs` with three additive options (`--audio-format`, `--audio-bitrate`, `--keep-output`), so the same tool that passed the trial's deployment, authentication, download, probe, and complete-decode checks can now run one candidate at a time and keep the accepted file for Apple-sided review. It ran on Vanta, from a copy in `/tmp/orbis-010-measure`, reading the API key from `keys.json` on stdin and never writing it to disk, argv, or a report. Sampled media was deleted after measurement.

Per candidate, the run recorded the tunnel's `Content-Disposition` filename extension, content type, byte count, `ffprobe` container and codec and duration, a complete `ffmpeg` decode, and the expected-duration difference. While each run executed, Vanta was sampled at 200 ms from the container's cgroup `cpu.stat` and `/proc/stat`, giving container CPU seconds, peak cores, and host busy time. The host is Debian 13, 12 logical CPUs, Docker 29.7.2, with 12 unrelated containers running. [11]

## What each Cobalt request actually produces

Read from upstream Cobalt 11.7.1 source at `a636575b`, the commit the pinned image reports. [1][2]

- `audioFormat` accepts `best / mp3 / ogg / wav / opus`; there is no AAC or M4A choice. `audioBitrate` accepts `320 / 256 / 128 / 96 / 64 / 8`, default `128`, and applies only to conversions. [1][3]
- `best` is not a format, it is a pass-through decision. For audio-only YouTube, the request is forced to the `vp9` codec bucket, whose audio codec is Opus, so `best` proxies YouTube's own Opus stream unchanged; the response filename is `.opus` while the bytes are WebM/Matroska and the content type is `audio/webm`. [4][5]
- For SoundCloud, `best` copies the source stream (`-c:a copy`). The extractor prefers an Opus transcoding and falls back to progressive MP3; on the measured Set it returned MP3, which Cobalt copies without re-encoding. [4][6]
- `mp3`, `ogg`, and `opus` all re-encode with `-b:a <audioBitrate>k`; `opus` additionally forces `-vbr off`, so it is hard CBR. [7]
- The default `audioBitrate` of 128 kbps therefore silently caps every conversion. The trial and [the issue comment](https://github.com/ParthMmm/orbis/issues/10) that read `ogg` output as "Ogg / Opus" measured a container, not a codec: `-f ogg` with a bitrate selects ffmpeg's default codec for that muxer, which is Vorbis. [2][3][4]

Two consequences follow before any measurement: `best` is the only request that never adds a lossy generation, and every conversion path is capped by `audioBitrate` at 128 kbps unless the request raises it.

## Per-candidate measurements

YouTube fixture, 596.501 s expected, measured 2026-09-14 on Vanta. Wall time is the smoke sample's processing plus download plus probe plus decode; container CPU seconds cover the whole run.

| `audioFormat` (bitrate) | Delivered container | Codec | Bytes | Bitrate | Wall | AVFoundation |
| --- | --- | --- | --- | --- | --- | --- |
| `best` | matroska,webm, named `.opus`, `audio/webm` | opus | 9,802,222 | 131.5 kbps | 2,638 ms | rejected |
| `mp3` (128) | mp3 | mp3 | 9,544,409 | 128.0 kbps | 12,093 ms | plays |
| `mp3` (320) | mp3 | mp3 | 23,860,889 | 320.0 kbps | 11,951 ms | plays |
| `ogg` (128) | ogg | **vorbis** | 8,606,447 | 115.4 kbps | 9,331 ms | plays, wrong |
| `ogg` (320) | ogg | vorbis | 21,314,495 | 285.9 kbps | 10,296 ms | plays, wrong |
| `opus` (128) | ogg | opus | 9,619,962 | 129.0 kbps | 18,145 ms | plays |
| `wav` | wav | pcm_s16le | 114,523,166 | 1,536 kbps | n/a | n/a |

SoundCloud fixture, 6902.49 s:

| `audioFormat` | Delivered container | Codec | Bytes | Bitrate | Wall | AVFoundation |
| --- | --- | --- | --- | --- | --- | --- |
| `best` | mp3 | mp3 | 110,440,068 | 128.0 kbps | 11,575 ms | plays |
| `mp3` (128) | mp3 | mp3 | 110,440,068 | 128.0 kbps | 106,142 ms | plays |
| `ogg` (128) | ogg | vorbis | 104,744,761 | 121.4 kbps | 100,706 ms | plays, wrong |
| `opus` (128) | ogg | opus | 111,316,282 | 129.0 kbps | 224,156 ms | plays |

Three measured facts sit behind those columns.

1. `ogg` is Ogg **Vorbis**, not Ogg Opus. `ffprobe` reports `codec_name=vorbis` on every `ogg` file from this deployment, on both sources. The issue comment's table records `ogg` as "Ogg / Opus"; that is a container reading, not a codec reading. Appendix A of the program tested a hand-made Ogg Opus file, so its "Ogg Opus plays" verdict never covered Cobalt's `ogg` output. [7][8]
2. `best` on YouTube is delivered as a `.opus` file whose bytes are WebM/Matroska, with `content-type: audio/webm` and a real `content-length`. The extension lies; only the container decides what the file is. [8]
3. SoundCloud `best` and SoundCloud `mp3` produce the same byte count and duration but different bytes (`7032bbb` versus `95e6703` in the run's kept files), and `best` finishes in 11.6 s against 106 s. `best` is a copy of SoundCloud's own MP3 stream; `mp3` is a second lossy generation that buys nothing. [8]

`wav` is recorded here for completeness and rejected on size and on decode: 114.5 MB for ten minutes, 1.3 GB for two hours, and it fails the strict `-xerror` complete-decode check because Cobalt streams WAV with a placeholder data-size field, which ffmpeg flags as "Ignoring maximum wav data size" and "Packet corrupt". The audio itself decodes when the strict flag is dropped. [8]

### Vanta CPU impact, measured per run

| Run | Fixture | Container CPU s | Peak cores | Host busy during run |
| --- | --- | --- | --- | --- |
| `best` | both | 4.37 | 1.19 | 1.0 % of 12 cores |
| `mp3` | both | 142.54 | 1.61 | 12.5 % |
| `ogg` | both | 132.30 | 1.64 | 11.1 % |
| `opus` | both | 248.10 | 1.24 | 20.8 % |
| `ogg` (320) | YouTube only | 12.21 | 1.64 | 10.0 % |
| `mp3` (320) | YouTube only | 13.79 | 1.50 | 12.4 % |
| `wav` | YouTube only | 3.90 | 2.61 | 4.4 % |

The container CPU for a run covers both fixtures in that run. The YouTube-only runs pin the YouTube cost per format, which leaves the SoundCloud share derivable: `mp3` about 128 s, `ogg` about 121 s, `opus` about 226 s of container CPU for one 1.9-hour Set. `best` costs 4.37 CPU seconds for both fixtures together, because a pass-through and a `-c:a copy` do no encoding work. No candidate exceeded 1.65 cores on a 12-core host, and the runbook's 90-percent-of-host-core gate is not approached by any of them. [8][11]

## AVFoundation verdicts, macOS 26.6 (Xcode 26.6, arm64)

Each accepted file was copied to this Mac and checked three ways: `afinfo` for the AudioFile open, an `AVAssetReader` probe that seeks into the file and counts real PCM samples, and an `AVPlayer` probe that plays and seeks. The probe scripts and the range server come from the media prototype in Appendix A. [7]

| Stored file | ffprobe | afinfo | AVFoundation load | PCM after seek to 300 s | Reported duration error |
| --- | --- | --- | --- | --- | --- |
| YouTube `best` raw (`.opus` name, WebM bytes) | matroska,webm / opus | `AudioFileOpenURL` failed | rejected, error −11849 / −12873 | none | not readable |
| `best` remuxed to Ogg (`-c:a copy`) | ogg / opus | `Oggf` / `opus` | plays | 476,832 samples, real PCM | −2.41 % |
| Cobalt `opus`, YouTube | ogg / opus | `Oggf` / `opus` | plays | 476,832 samples | +0.79 % |
| Cobalt `opus`, SoundCloud 1.9 h | ogg / opus | `Oggf` / `opus` | plays | decodes at 3600 s and 6890 s | +0.79 % |
| Cobalt `ogg`, YouTube | ogg / **vorbis** | `Oggf` / `vorb` | plays | 375,336 samples | −2.73 % |
| Cobalt `ogg`, SoundCloud 1.9 h | ogg / vorbis | `Oggf` / `vorb` | plays | decodes at 3600 s | **−9.15 %** |
| Cobalt `mp3`, YouTube | mp3 / mp3 | `MPG3` / `.mp3` | plays | 480,000 samples | 0 %, exact |
| Cobalt `mp3` (320) | mp3 / mp3 | `MPG3` / `.mp3` | plays | 480,000 samples | 0 %, exact |
| SoundCloud `best` (mp3, 1.9 h) | mp3 / mp3 | `MPG3` / `.mp3` | plays | decodes at 3600 s and 6890 s | 0 %, exact |

Full-file decode frame counts on the ten-minute YouTube fixture, as read back by `AVAssetReader` at 48 kHz stereo:

| File | Int16 samples decoded | Frames | Expected frames for 596.5 s | Verdict |
| --- | --- | --- | --- | --- |
| mp3 128 | 57,265,920 | 28,632,960 | 28,632,960 | exact |
| Ogg Opus (`opus`) | 57,261,524 | 28,630,762 | 28,632,960 | exact to within the final packet |
| Ogg Vorbis (`ogg`) | 55,705,600 | 27,852,800 | 28,632,960 | **778,090 frames short, 16.2 s of audio** |

So macOS 26.6 does decode Vorbis, and it plays the files, but it misreports Vorbis duration by between −2.7 % and +14.3 % depending on the file, and its own full decode of a ten-minute Vorbis file delivers 2.7 % fewer frames than the container advertises. On the 1.9-hour Set the reported duration is 6270.82 s against a measured 6902.45 s. That is disqualifying for a stored default. [8]

Ogg Opus is fully decodable and seeks accurately, with one defect: AVFoundation's reported duration is wrong by a small, writer-dependent percentage, −2.41 % for a copy-remuxed file and +0.79 % for Cobalt's own conversion, even though both files carry correct Ogg granule positions (`28632024` and `28631410` at 48 kHz). MP3 is exact on every count. [8]

## The container-only fix, measured

Remuxing the delivered WebM/Opus to Ogg with `ffmpeg -i in -map 0:a:0 -c:a copy out.ogg` preserves the audio bit for bit: the decoded PCM of the source and the remux are identical for 28,630,760 of 28,630,762 frames, the final two frames differing only in muxer padding. The remux costs 0.229 s on this Mac and 0.146 s on Vanta for the ten-minute file, and 0.903 s on Vanta for a synthetic 1.99-hour Matroska built by concatenating the same file twelve times, so the cost is roughly 0.5 CPU-seconds per hour of audio, single-threaded. The output is 1.4 % smaller than the input because Matroska overhead goes away. [8]

The same measurement on the Cobalt `opus` conversion, for contrast: it re-encodes 131.5 kbps Opus into 129.0 kbps CBR Opus, costs 18.1 s of wall and 226 CPU-seconds for a 1.9-hour Set, and produces a file 2 % larger than the remux for strictly less information. [8]

## Byte-range behaviour

- A `best` tunnel is a pass-through: it carries `content-length`, a content type, and `Content-Disposition`. A converted tunnel carries none of those: `Transfer-Encoding: chunked`, `Estimated-Content-Length` as a guess, no `content-type`, no `accept-ranges`. A ranged fetch of a converted stream from Cobalt is therefore impossible, and the download worker must stream the body to disk and enforce its own size bound. Measured against the deployment for `best`, `ogg`, `opus`, and `mp3`. [8]
- Once stored, the file is served by Orbis, and AVFoundation needs byte ranges. Measured again here: every request AVFoundation made to the prototype range server carried a `Range` header, 6 of 6 for the remuxed Ogg Opus and the 1.9-hour MP3, `bytes=0-1` first, then a full read, then a mid-file read after a seek. Nothing in the selected output needs more than standard `accept-ranges: bytes` with `206` responses. [7][8]

## Recommendation

Request `best` and never ask Cobalt to transcode. Exact request parameters:

```json
{
  "url": "<saved source URL>",
  "downloadMode": "audio",
  "audioFormat": "best",
  "localProcessing": "disabled",
  "alwaysProxy": true
}
```

with the API key in `Authorization: Api-Key <key>` and no `audioBitrate` field. The absence of `audioBitrate` is deliberate: it only applies to conversions, and the point of this default is that no conversion happens.

At store time, decide the container from `ffprobe`, never from the delivered filename:

- Container is `matroska,webm` (YouTube `best`): remux with `ffmpeg -i <file> -map 0:a:0 -c:a copy <name>.ogg`. Bit-exact, 0.9 s per two hours, measured above. Store the ffprobe-measured duration with the Set.
- Container is already Apple-playable, which is what SoundCloud `best` delivers today (mp3): store as received. No processing step at all.

Stored result: Opus at the source bitrate of about 131 kbps for YouTube, MP3 at 128 kbps CBR for SoundCloud, each exactly as the source delivered it, with no second lossy generation anywhere in the pipeline. Orbis records the real duration at store time and treats AVFoundation's Ogg duration reading as approximate, seeking in absolute seconds rather than as a fraction of AVFoundation's reported duration.

## Rejected alternatives, with measured reasons

- **`ogg` (Cobalt's conversion).** It is Vorbis, not Opus. AVFoundation plays it but misreports duration by up to 14 %, and its full decode of a ten-minute file drops 2.7 % of the audio. A second lossy generation from Opus to Vorbis for a file that cannot be trusted to seek or end correctly. [8]
- **`mp3`.** The Apple-safest candidate and the only one AVFoundation reads exactly, but it is a lossy transcode of an Opus source: 128 kbps costs 12.1 s of conversion for ten minutes and 106 s for the 1.9-hour Set, and 320 kbps raises the bytes to 2.5 times the source without adding information the source does not have. SoundCloud `mp3` re-encodes a file that `best` copies in a tenth of the time. [8]
- **`opus` (Cobalt's conversion).** Same container as the recommendation but a re-encode: 226 CPU-seconds for the 1.9-hour Set against a remux cost under one second, for a file that carries less information than the `best` pass-through. Its hard CBR setting (`-vbr off` in `ffmpeg.js`) also fixes the bitrate at the requested value, so raising it to 320 only inflates the file. [3][8]
- **`wav`.** 13 times the bytes of the source, 1.3 GB per two hours, and it fails the strict complete-decode check because Cobalt streams it with a placeholder data-size field. [8]
- **AAC or m4a.** Not offered. `audioFormat` has no AAC member, and on this deployment the AAC path is unreachable: audio-only YouTube requests force the `vp9` bucket, whose audio codec is Opus, and `m4a` appears only as an internal fallback when a service reports no best audio at all. SoundCloud's extractor selects Opus or MP3 transcodings, never AAC, for audio mode. [1][3][5][6]
- **Store `best` as delivered.** Rejected on the Apple evidence: AVFoundation cannot open the WebM/Matroska container, with `afinfo` refusing the file outright and `AVURLAsset` failing with error −11849 / −12873 before any duration or track can be read. [8]
- **Store MP3 unconditionally as the safe default.** Deferred in Appendix B of the program and now rejected on measurement, because the measured alternative preserves the source exactly, is smaller, and costs no conversion at all on SoundCloud. [7][8]

## What stays unproven

- Ogg Opus and MP3 playback on real iOS hardware, and over Tailscale rather than loopback. [Play Retained Audio with system media controls](https://github.com/ParthMmm/orbis/issues/13) owns both, and this decision is conditional on that lane passing. The macOS verdicts above are from this Mac only; the iOS simulator was not exercised here.
- A permitted fixture over three hours does not exist, so the over-three-hour case stays blocked, as in the trial. The 1.9-hour Set and the synthetic two-hour remux bound the measurements that exist.
- The `VISIONOS` client dependency [the decision record](../adr/0003-cobalt-youtube-client.md) already accepts: if YouTube tightens that client, the format question changes shape. [7]
- AVFoundation's Ogg duration misreport is measured but not diagnosed to a line. The mitigation, storing Orbis's own ffprobe duration and seeking in absolute seconds, does not depend on the cause.

## Sources

1. [API documentation](https://github.com/imputnet/cobalt/blob/main/docs/api.md) — `audioFormat` and `audioBitrate` members and defaults.
2. [API schema](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/schema.js) — the exact enum members, `audioFormat` `best / mp3 / ogg / wav / opus`, `audioBitrate` default `128`.
3. [Audio conversion](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/stream/ffmpeg.js) — `convertAudio`: `-b:a <bitrate>k`, `-vbr off` for `opus`, `-f <format>`.
4. [Match action](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/match-action.js) — the `best` branch: pass-through when a service reports best audio, `audioCopy` for SoundCloud, `-c:a copy`.
5. [YouTube extractor](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/services/youtube.js) and [match.js](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/match.js) — audio-only requests force codec `vp9`, so the Opus bucket wins; `bestAudio` becomes `opus`.
6. [SoundCloud extractor](https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/services/soundcloud.js) — Opus transcoding preferred, progressive MP3 fallback, `isHLS` from the resolved URL.
7. [The media prototype](../plans/native-clients-program.md), Appendix A — the AVFoundation table this file re-tests, the range-request evidence, and the range server and probe reused here.
8. This measurement, 2026-09-14. Reports, raw CPU samples, and tunnel headers were taken on Vanta in `/tmp/orbis-010-measure` with `scripts/smoke-cobalt.mjs` extended by `--audio-format`, `--audio-bitrate`, and `--keep-output`; the accepted files were copied to this Mac and probed with `afinfo`, `ffprobe`, `AVAssetReader`, `AVPlayer`, and `afconvert`. Probe media was deleted after measurement.
9. [ADR 0003](../adr/0003-cobalt-youtube-client.md) — the client change that made YouTube `best` return Opus in Matroska.
10. [The trial evidence](../ops/cobalt-trial-evidence.md) — the SoundCloud `best` result this file reproduces, and the blocked over-three-hour case.
11. [The trial runbook](../ops/cobalt-trial.md) — deployment identity, bounds, and the read-only host checks this measurement reused.
