import { rm } from "node:fs/promises";

import { Context, Effect, Exit, Layer } from "effect";

import { LibraryError } from "./errors.js";

export interface YtdlpRunResult {
  readonly code: number;
  readonly stdout: string;
}

export type YtdlpRunner = (
  argv: readonly string[],
  signal: AbortSignal
) => Promise<YtdlpRunResult>;

export interface YtdlpOptions {
  // Absolute path to the yt-dlp binary. It is never looked up on PATH.
  readonly ytdlpBin?: string | undefined;
  readonly ytdlpCookies?: string | undefined;
  readonly ytdlpRun?: YtdlpRunner;
}

const YTDLP_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_POLL_MS = 500;
// Matches MAX_AUDIO_BYTES in media-store.ts so both backends share one size bound.
const MAX_FILESIZE = "2G";

const downloadFailed = (reason: string) =>
  new LibraryError({ message: reason, statusCode: 500 });

const spawnRunner: YtdlpRunner = async (argv, signal) => {
  const proc = Bun.spawn([...argv], {
    signal: AbortSignal.any([signal, AbortSignal.timeout(YTDLP_TIMEOUT_MS)]),
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { code, stdout };
};

// Fixed argument list. The URL is data after `--`, so it can never read as a flag.
export const ytdlpArgs = (
  bin: string,
  destination: string,
  url: string,
  cookies?: string
): readonly string[] => [
  bin,
  "--ignore-config",
  "--no-playlist",
  "--no-progress",
  "--no-warnings",
  "--no-part",
  "--no-continue",
  "--no-mtime",
  "--max-filesize",
  MAX_FILESIZE,
  "-f",
  "bestaudio",
  "-o",
  destination,
  ...(cookies ? ["--cookies", cookies] : []),
  "--",
  url,
];

export class Ytdlp extends Context.Service<
  Ytdlp,
  {
    readonly isConfigured: boolean;
    readonly download: (
      sourceUrl: string,
      destination: string,
      onProgress: (received: number, total: number | null) => void,
      signal: AbortSignal
    ) => Effect.Effect<void, LibraryError>;
  }
>()("@orbis/Ytdlp") {
  static layer(options: YtdlpOptions = {}): Layer.Layer<Ytdlp> {
    const bin = options.ytdlpBin;
    const run = options.ytdlpRun ?? spawnRunner;
    return Layer.effect(
      Ytdlp,
      Effect.gen(function* buildYtdlp() {
        if (!bin) {
          return Ytdlp.of({
            download: () =>
              Effect.fail(downloadFailed("yt-dlp is not configured.")),
            isConfigured: false,
          });
        }
        // A broken extractor is identifiable from the version alone.
        yield* Effect.tryPromise(() =>
          run([bin, "--version"], new AbortController().signal)
        ).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.logWarning("yt-dlp version unreadable"),
            onSuccess: (ran) =>
              Effect.logInfo("yt-dlp ready").pipe(
                Effect.annotateLogs({ version: ran.stdout.trim() })
              ),
          })
        );
        const attempt = (
          sourceUrl: string,
          destination: string,
          onProgress: (received: number, total: number | null) => void,
          signal: AbortSignal,
          cookies?: string
        ) =>
          Effect.tryPromise({
            catch: () =>
              downloadFailed(
                signal.aborted
                  ? "The download was canceled."
                  : "yt-dlp could not run."
              ),
            try: async () => {
              const timer = setInterval(() => {
                const { size } = Bun.file(destination);
                if (size > 0) {
                  onProgress(size, null);
                }
              }, PROGRESS_POLL_MS);
              try {
                return await run(
                  ytdlpArgs(bin, destination, sourceUrl, cookies),
                  signal
                );
              } finally {
                clearInterval(timer);
              }
            },
          }).pipe(
            Effect.flatMap((ran) =>
              ran.code === 0 && Bun.file(destination).size > 0
                ? Effect.void
                : Effect.fail(
                    downloadFailed("yt-dlp could not fetch this audio.")
                  )
            )
          );
        return Ytdlp.of({
          download: Effect.fn("Ytdlp.download")(function* download(
            sourceUrl: string,
            destination: string,
            onProgress: (received: number, total: number | null) => void,
            signal: AbortSignal
          ) {
            const removePartial = Effect.promise(() =>
              Promise.allSettled([
                rm(destination, { force: true }),
                rm(`${destination}.ytdl`, { force: true }),
              ])
            );
            // Cookies are a fallback for content that refuses anonymous access.
            const cookies = options.ytdlpCookies;
            const anonymous = attempt(
              sourceUrl,
              destination,
              onProgress,
              signal
            );
            const tried =
              cookies && cookies.length > 0
                ? anonymous.pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        signal.aborted
                          ? Effect.fail(error)
                          : removePartial.pipe(
                              Effect.andThen(
                                attempt(
                                  sourceUrl,
                                  destination,
                                  onProgress,
                                  signal,
                                  cookies
                                )
                              )
                            ),
                      onSuccess: () => Effect.void,
                    })
                  )
                : anonymous;
            yield* tried.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : removePartial
              )
            );
          }),
          isConfigured: true,
        });
      })
    );
  }
}
