import { rename, rm } from "node:fs/promises";

import { Context, Effect, Exit, Layer } from "effect";

import { LibraryError } from "./errors.js";
import { outputHead, outputTail } from "./logging.js";
import { youTubeVideoId } from "./source-url.js";

export interface YtdlpRunResult {
  readonly code: number;
  readonly stderr?: string;
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
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
};

// Fixed argument list. The URL is data after `--`, so it can never read as a flag.
export const ytdlpArgs = (
  bin: string,
  destination: string,
  url: string,
  cookies?: string,
  playerClient?: string
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
  ...(playerClient
    ? ["--extractor-args", `youtube:player_client=${playerClient}`]
    : []),
  ...(cookies ? ["--cookies", cookies] : []),
  "--",
  url,
];

interface DownloadAttempt {
  readonly cookies?: string;
  readonly playerClient?: string;
}

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
          cookies?: string,
          playerClient?: string
        ) => {
          // yt-dlp strips a trailing `.part` from `-o`, so it writes here and the file moves after.
          const output = `${destination}.ytdl`;
          return Effect.tryPromise({
            catch: () =>
              downloadFailed(
                signal.aborted
                  ? "The download was canceled."
                  : "yt-dlp could not run."
              ),
            try: async () => {
              const timer = setInterval(() => {
                const { size } = Bun.file(output);
                if (size > 0) {
                  onProgress(size, null);
                }
              }, PROGRESS_POLL_MS);
              try {
                return await run(
                  ytdlpArgs(bin, output, sourceUrl, cookies, playerClient),
                  signal
                );
              } finally {
                clearInterval(timer);
              }
            },
          }).pipe(
            Effect.flatMap((ran) =>
              ran.code === 0 && Bun.file(output).size > 0
                ? Effect.promise(() => rename(output, destination))
                : Effect.logWarning("yt-dlp run failed").pipe(
                    Effect.annotateLogs({
                      bytes: Bun.file(output).size,
                      exitCode: ran.code,
                      playerClient: playerClient ?? "default",
                      signedIn: cookies !== undefined,
                      stderr: outputTail(ran.stderr ?? ""),
                      stderrHead: outputHead(ran.stderr ?? ""),
                    }),
                    Effect.andThen(
                      Effect.fail(
                        downloadFailed("yt-dlp could not fetch this audio.")
                      )
                    )
                  )
            )
          );
        };
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
            // YouTube's default anonymous clients can be refused with a sign-in challenge
            // while the supported web_embedded client still serves the same audio, so one
            // alternate-client attempt follows the default before credentials are tried.
            const alternateClient = youTubeVideoId(sourceUrl)
              ? "web_embedded"
              : undefined;
            const plan: readonly DownloadAttempt[] = [
              {},
              ...(alternateClient ? [{ playerClient: alternateClient }] : []),
              ...(cookies && cookies.length > 0 ? [{ cookies }] : []),
            ];
            // The plan always starts with the anonymous default attempt.
            const [primary = {}, ...fallbacks] = plan;
            const runAttempt = (step: DownloadAttempt) =>
              attempt(
                sourceUrl,
                destination,
                onProgress,
                signal,
                step.cookies,
                step.playerClient
              );
            let tried = runAttempt(primary);
            for (const fallback of fallbacks) {
              tried = tried.pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    signal.aborted
                      ? Effect.fail(error)
                      : removePartial.pipe(
                          Effect.andThen(runAttempt(fallback))
                        ),
                  onSuccess: () => Effect.void,
                })
              );
            }
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
