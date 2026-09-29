import { Effect, Option, Schema, Semaphore } from "effect";

import { MetadataError } from "./metadata-error.js";

/** Everything yt-dlp reports about one Source Link that Orbis can group, tag, or search by. */
export interface SourceDetails {
  readonly chapters: readonly Chapter[];
  readonly creator: string | null;
  /** The provider's stable id for the creator. Names change and collide; ids do not. */
  readonly creatorId: string | null;
  readonly creatorUrl: string | null;
  readonly description: string | null;
  readonly durationSeconds: number | null;
  readonly genre: string | null;
  readonly releasedAt: string | null;
  readonly tags: readonly string[];
  readonly thumbnailUrl: string | null;
  readonly title: string;
}

export interface Chapter {
  readonly startSeconds: number;
  readonly title: string;
}

export interface YtDlpMetadataService {
  readonly read: (url: string) => Effect.Effect<SourceDetails, MetadataError>;
}

/** Runs the binary with these arguments and returns its stdout, or `null` when it exits non-zero. */
export type RunYtDlp = (
  binPath: string,
  args: readonly string[],
  signal: AbortSignal
) => Promise<string | null>;

export interface YtDlpMetadataOptions {
  /** Absolute path to the pinned binary. It is never resolved through `PATH`. */
  readonly binPath: string;
  /** How many yt-dlp processes may run at once. Further reads wait for a free slot. */
  readonly maxConcurrent?: number;
  readonly run?: RunYtDlp;
}

const TIMEOUT = "15 seconds";

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optionalKey(Schema.NullOr(Schema.Number));
const StringList = Schema.optionalKey(
  Schema.NullOr(Schema.Array(Schema.String))
);

const DumpedJson = Schema.Struct({
  channel: NullableString,
  channel_id: NullableString,
  channel_url: NullableString,
  chapters: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          start_time: Schema.Number,
          title: Schema.String,
        })
      )
    )
  ),
  description: NullableString,
  duration: NullableNumber,
  genre: NullableString,
  tags: StringList,
  thumbnail: NullableString,
  timestamp: NullableNumber,
  title: Schema.String,
  upload_date: NullableString,
  uploader: NullableString,
  uploader_id: NullableString,
  uploader_url: NullableString,
});

type Dumped = typeof DumpedJson.Type;

const UPLOAD_DATE = /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})$/u;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

const ENTITY =
  /&(?:#(?<dec>\d+)|#[xX](?<hex>[\da-fA-F]+)|(?<name>[a-zA-Z]+));/gu;

const isCodePoint = (code: number) =>
  code > 0 && code <= 0x10_ff_ff && !(code >= 0xd8_00 && code <= 0xdf_ff);

/** One pass, so `&amp;lt;` becomes `&lt;` and not `<`. Unknown or invalid entities stay as written. */
export const decodeHtmlEntities = (value: string): string =>
  value
    .replaceAll(
      ENTITY,
      (
        whole: string,
        dec: string | undefined,
        hex: string | undefined,
        name: string | undefined
      ) => {
        if (name) {
          return NAMED_ENTITIES.get(name) ?? whole;
        }
        const code = dec ? Number(dec) : Number.parseInt(hex ?? "", 16);
        return isCodePoint(code) ? String.fromCodePoint(code) : whole;
      }
    )
    .replaceAll("\u00A0", " ");

const text = (value: string | null | undefined): string | null =>
  value?.trim() || null;

const words = (values: readonly string[] | null | undefined) => [
  ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
];

/** yt-dlp gives a Unix time when the provider does, and `YYYYMMDD` when it gives only a day. */
const releasedAt = (dumped: Dumped): string | null => {
  const seconds = Option.fromNullishOr(dumped.timestamp);
  if (Option.isSome(seconds)) {
    return new Date(seconds.value * 1000).toISOString();
  }
  const day = UPLOAD_DATE.exec(dumped.upload_date ?? "")?.groups;
  return day ? `${day.year}-${day.month}-${day.day}T00:00:00.000Z` : null;
};

export const sourceDetailsFrom = (dumped: Dumped): SourceDetails => ({
  chapters: (dumped.chapters ?? []).flatMap((chapter) => {
    const title = chapter.title.trim();
    return title ? [{ startSeconds: chapter.start_time, title }] : [];
  }),
  creator: text(dumped.channel) ?? text(dumped.uploader),
  creatorId: text(dumped.channel_id) ?? text(dumped.uploader_id),
  creatorUrl: text(dumped.channel_url) ?? text(dumped.uploader_url),
  description: text(decodeHtmlEntities(dumped.description ?? "")),
  durationSeconds: Option.getOrNull(
    Option.map(Option.fromNullishOr(dumped.duration), Math.round)
  ),
  genre: text(dumped.genre),
  releasedAt: releasedAt(dumped),
  tags: words(dumped.tags),
  thumbnailUrl: text(dumped.thumbnail),
  title: dumped.title.trim(),
});

const bunRun: RunYtDlp = async (binPath, args, signal) => {
  const proc = Bun.spawn([binPath, ...args], {
    signal,
    stderr: "ignore",
    stdout: "pipe",
  });
  const [output, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return code === 0 ? output : null;
};

const failure = (
  message: string,
  reason: MetadataError["reason"] = "provider-unavailable"
) => new MetadataError({ message, reason });

export const ytDlpMetadata = (
  options: YtDlpMetadataOptions
): YtDlpMetadataService => {
  const run = options.run ?? bunRun;
  const slots = Semaphore.makeUnsafe(Math.max(1, options.maxConcurrent ?? 2));
  const read = Effect.fn("YtDlpMetadata.read")(function* read(url: string) {
    // `--` ends option parsing so a URL can never be read as a flag. No shell is involved.
    const args = [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--",
      url,
    ];
    const output = yield* Effect.tryPromise({
      catch: () => failure("yt-dlp could not be run."),
      try: (signal) => run(options.binPath, args, signal),
    }).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.fail(failure("yt-dlp did not answer in time.")),
      }),
      // The permit wraps the timeout, so the 15 seconds count from the start of the run.
      slots.withPermits(1)
    );
    if (output === null) {
      return yield* Effect.fail(failure("yt-dlp could not read this link."));
    }
    const body: unknown = yield* Effect.try({
      catch: () =>
        failure("yt-dlp did not answer with JSON.", "unexpected-response"),
      try: () => JSON.parse(output),
    });
    const decoded = Schema.decodeUnknownOption(DumpedJson)(body);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        failure("yt-dlp omitted the fields Orbis reads.", "unexpected-response")
      );
    }
    const details = sourceDetailsFrom(decoded.value);
    if (!details.title) {
      return yield* Effect.fail(
        failure(
          "yt-dlp returned a link without a title.",
          "unexpected-response"
        )
      );
    }
    return details;
  });
  return { read };
};
