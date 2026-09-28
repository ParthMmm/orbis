# Set up yt-dlp for Set metadata

Orbis reads Set details (tags, chapters, description, genre, creator id) with yt-dlp. The choice and the measured install come from [the yt-dlp fallback evidence](yt-dlp-fallback-evidence.md). This page covers the install, the configuration, and the backfill for Sets saved before details existed.

Run the steps on each host that runs the Orbis server: Vanta (Linux) and the Mac.

## Install

The bare `yt-dlp` package is not enough. YouTube needs a JavaScript runtime and the `yt-dlp-ejs` solver scripts. The `[default]` extra carries `yt-dlp-ejs`. Deno is the runtime yt-dlp detects on its own.

On the Mac:

```sh
uv tool install 'yt-dlp[default]'
uv tool install deno
```

On Vanta, run the same two commands over SSH. State the host before you change anything: `ssh vanta`.

```sh
export PATH="$HOME/.local/bin:$PATH"
uv tool install 'yt-dlp[default]'
uv tool install deno
```

Check that yt-dlp found the runtime:

```sh
yt-dlp --version
yt-dlp -v --simulate -- https://www.youtube.com/watch?v=tPEMP9oYxTo 2>&1 | grep 'JS runtimes'
```

Expect `JS runtimes: deno-<version>`. The trial used yt-dlp 2026.08.19 and Deno 2.9.6.

## Configure

Set `ORBIS_YTDLP_BIN` to the absolute path of the binary. Orbis never resolves it through `PATH`, and it rejects a relative path.

```sh
which yt-dlp
# Example: /home/parth/.local/bin/yt-dlp on Vanta, /Users/parthmangrola/.local/bin/yt-dlp on the Mac
export ORBIS_YTDLP_BIN=/absolute/path/to/yt-dlp
```

yt-dlp finds Deno through the `PATH` of the process that starts it. When you run the server or backfill from a service or a shell without `~/.local/bin` on `PATH`, add that directory to the service `PATH`.

Extractors break often. Upgrade on a schedule with `uv tool upgrade yt-dlp`, then run the smoke test again. Keep the binary path fixed, not the version.

## Smoke test

Run this before the backfill. It prints one JSON object and downloads nothing.

```sh
"$ORBIS_YTDLP_BIN" --dump-single-json --skip-download -- https://www.youtube.com/watch?v=tPEMP9oYxTo | head -c 400
```

A JSON object that starts with `"id"` means the install works.

## Backfill Sets saved before details existed

Sets whose `source_tags` column is `NULL` have no details. From `apps/server` on the host that holds the library:

```sh
ORBIS_YTDLP_BIN=/absolute/path/to/yt-dlp bun run backfill:details
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBIS_YTDLP_BIN` | none, required | Absolute path to yt-dlp. The script exits with a message when it is missing or relative. |
| `ORBIS_DATA_DIR` | `data` | Directory that holds `library.sqlite`. |
| `ORBIS_BACKFILL_DELAY_MS` | `1000` | Pause between Sets, so providers are not hit in a burst. |

The script goes through Sets one at a time and logs each one. A Set that fails keeps what it has, and the run goes on. The script exits non-zero if any Set failed. Run it again: it only picks up Sets that still have no details.

## What fails without Deno

Without a JavaScript runtime, or with the bare wheel that lacks `yt-dlp-ejs`, every YouTube extraction fails. The log shows `Signature solving failed`, `n challenge solving failed`, and `Only images are available for download`. Orbis then reports the provider as unavailable, and the backfill counts the Set as failed and leaves it for the next run. SoundCloud does not need the runtime.

Fix: install Deno with `uv tool install deno`, make sure it is on the `PATH` of the process that runs yt-dlp, and run the smoke test again.
