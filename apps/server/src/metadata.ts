import type { SetSource } from "@orbis/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { MetadataError } from "./metadata-error.js";
import { youTubeVideoId } from "./source-url.js";

export interface EnrichedMetadata {
  readonly artworkUrl: string | null;
  readonly artworkLargeUrl: string | null;
  readonly creator: string | null;
  readonly durationSeconds: number | null;
  readonly title: string;
}

export interface EnrichInput {
  readonly source: SetSource;
  readonly url: string;
}

export interface MetadataService {
  readonly enrich: (
    input: EnrichInput
  ) => Effect.Effect<EnrichedMetadata, MetadataError>;
}

export interface MetadataOptions {
  readonly fetch?: RequestFetch;
  readonly youTubeApiKey?: string | undefined;
}

type RequestFetch = (url: string, signal: AbortSignal) => Promise<Response>;

interface Provider {
  readonly enrich: (
    url: string
  ) => Effect.Effect<EnrichedMetadata, MetadataError>;
}

interface ProviderOptions {
  readonly label: string;
  readonly request: RequestFetch;
}

const PROVIDER_TIMEOUT = "5 seconds";

const notConfigured = (message: string) =>
  new MetadataError({ message, reason: "not-configured" });
const rejected = (message: string) =>
  new MetadataError({ message, reason: "provider-rejected" });
const unavailable = (message: string) =>
  new MetadataError({ message, reason: "provider-unavailable" });
const unexpected = (message: string) =>
  new MetadataError({ message, reason: "unexpected-response" });
const unsupported = (message: string) =>
  new MetadataError({ message, reason: "unsupported-source" });

const ISO_DURATION =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/u;
const HAS_DIGIT = /\d/u;

const unitSeconds = (value: string | undefined, scale: number) =>
  value ? Number(value) * scale : 0;

const parseDurationSeconds = (duration: string): number | null => {
  const groups = ISO_DURATION.exec(duration)?.groups;
  if (!(groups && HAS_DIGIT.test(duration))) {
    return null;
  }
  return (
    unitSeconds(groups.days, 86_400) +
    unitSeconds(groups.hours, 3600) +
    unitSeconds(groups.minutes, 60) +
    unitSeconds(groups.seconds, 1)
  );
};

const youTubeRequest = (videoId: string, apiKey: string): string => {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("part", "snippet,contentDetails");
  return url.toString();
};

const soundCloudRequest = (url: string): string => {
  const endpoint = new URL("https://soundcloud.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", url);
  return endpoint.toString();
};

const requestJson = <S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  schema: S,
  options: ProviderOptions
): Effect.Effect<S["Type"], MetadataError> =>
  Effect.gen(function* readProvider() {
    const response = yield* Effect.tryPromise({
      catch: () => unavailable(`${options.label} is unreachable.`),
      try: (signal) => options.request(url, signal),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        response.status >= 500
          ? unavailable(`${options.label} answered ${response.status}.`)
          : rejected(`${options.label} rejected this request.`)
      );
    }
    const body: unknown = yield* Effect.tryPromise({
      catch: () => unexpected(`${options.label} did not answer with JSON.`),
      try: () => response.json(),
    });
    const decoded = Schema.decodeUnknownOption(schema)(body);
    if (Option.isNone(decoded)) {
      return yield* Effect.fail(
        unexpected(`${options.label} omitted the fields Orbis reads.`)
      );
    }
    return decoded.value;
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROVIDER_TIMEOUT,
      orElse: () =>
        Effect.fail(unavailable(`${options.label} did not answer in time.`)),
    })
  );

const YouTubeThumbnail = Schema.Struct({ url: Schema.String });

const YouTubeResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      contentDetails: Schema.Struct({ duration: Schema.String }),
      snippet: Schema.Struct({
        channelTitle: Schema.String,
        thumbnails: Schema.Struct({
          default: Schema.optionalKey(YouTubeThumbnail),
          high: Schema.optionalKey(YouTubeThumbnail),
          maxres: Schema.optionalKey(YouTubeThumbnail),
          medium: Schema.optionalKey(YouTubeThumbnail),
          standard: Schema.optionalKey(YouTubeThumbnail),
        }),
        title: Schema.String,
      }),
    })
  ),
});

const SoundCloudResponse = Schema.Struct({
  author_name: Schema.optionalKey(Schema.String),
  thumbnail_url: Schema.optionalKey(Schema.String),
  title: Schema.String,
});

type YouTubeVideo = (typeof YouTubeResponse.Type)["items"][number];
type YouTubeThumbnails = YouTubeVideo["snippet"]["thumbnails"];
type SoundCloudOEmbed = typeof SoundCloudResponse.Type;

/** The image a listing draws: `medium` is 320x180, which is an 88-point row at 3x. */
const listingArtworkFrom = (thumbnails: YouTubeThumbnails): string | null =>
  thumbnails.medium?.url ??
  thumbnails.high?.url ??
  thumbnails.standard?.url ??
  thumbnails.default?.url ??
  null;

/** The image a Set's own page draws: the sharpest the video has. */
const pageArtworkFrom = (thumbnails: YouTubeThumbnails): string | null =>
  thumbnails.maxres?.url ??
  thumbnails.standard?.url ??
  thumbnails.high?.url ??
  thumbnails.medium?.url ??
  thumbnails.default?.url ??
  null;

const youTubeMetadata = (video: YouTubeVideo): EnrichedMetadata => ({
  artworkLargeUrl: pageArtworkFrom(video.snippet.thumbnails),
  artworkUrl: listingArtworkFrom(video.snippet.thumbnails),
  creator: video.snippet.channelTitle.trim() || null,
  durationSeconds: parseDurationSeconds(video.contentDetails.duration),
  title: video.snippet.title.trim(),
});

/** SoundCloud's oEmbed names one image and no size to ask for, so both places draw it. */
const soundCloudMetadata = (track: SoundCloudOEmbed): EnrichedMetadata => ({
  artworkLargeUrl: track.thumbnail_url ?? null,
  artworkUrl: track.thumbnail_url ?? null,
  creator: track.author_name?.trim() || null,
  durationSeconds: null,
  title: track.title.trim(),
});

const youTubeProvider = (
  youTubeApiKey: string,
  request: RequestFetch
): Provider => ({
  enrich: (url) =>
    Effect.gen(function* enrichYouTube() {
      const videoId = youTubeVideoId(url);
      if (!videoId) {
        return yield* Effect.fail(
          unsupported("This URL does not name a YouTube video.")
        );
      }
      const response = yield* requestJson(
        youTubeRequest(videoId, youTubeApiKey),
        YouTubeResponse,
        { label: "YouTube", request }
      );
      const [video] = response.items;
      if (!video) {
        return yield* Effect.fail(
          rejected("YouTube does not have this video.")
        );
      }
      const metadata = youTubeMetadata(video);
      if (!metadata.title) {
        return yield* Effect.fail(
          unexpected("YouTube returned a video without a title.")
        );
      }
      return metadata;
    }),
});

const soundCloudProvider = (request: RequestFetch): Provider => ({
  enrich: (url) =>
    Effect.gen(function* enrichSoundCloud() {
      const response = yield* requestJson(
        soundCloudRequest(url),
        SoundCloudResponse,
        { label: "SoundCloud", request }
      );
      const metadata = soundCloudMetadata(response);
      if (!metadata.title) {
        return yield* Effect.fail(
          unexpected("SoundCloud returned a track without a title.")
        );
      }
      return metadata;
    }),
});

const noProviders: MetadataService = {
  enrich: (input) =>
    Effect.fail(
      notConfigured(
        `${input.source} enrichment is not configured on this server.`
      )
    ),
};

export class Metadata extends Context.Service<Metadata, MetadataService>()(
  "@orbis/Metadata"
) {
  static layer(options: MetadataOptions = {}): Layer.Layer<Metadata> {
    const request = options.fetch ?? ((url, signal) => fetch(url, { signal }));
    const providers: Partial<Record<SetSource, Provider>> = {
      soundcloud: soundCloudProvider(request),
    };
    if (options.youTubeApiKey) {
      providers.youtube = youTubeProvider(options.youTubeApiKey, request);
    }
    return Layer.succeed(Metadata, {
      enrich: (input) =>
        providers[input.source]?.enrich(input.url) ?? noProviders.enrich(input),
    });
  }

  /**
   * No provider is reachable. This is the default so that a save never waits on the network
   * unless a caller asks for providers, which keeps tests offline by construction.
   */
  static unconfigured(): Layer.Layer<Metadata> {
    return Layer.succeed(Metadata, noProviders);
  }

  static layerOf(metadata: MetadataService): Layer.Layer<Metadata> {
    return Layer.succeed(Metadata, metadata);
  }
}
