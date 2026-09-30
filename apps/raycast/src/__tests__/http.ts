export interface RecordedRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

export const requests: RecordedRequest[] = [];

export const resetRequests = () => {
  requests.length = 0;
};

export type FetchHandler = (
  request: RecordedRequest,
  init: RequestInit
) => Promise<Response> | Response;

/**
 * Replaces the global fetch and records each request, so a test can assert both that no
 * request was sent and exactly what Orbis would have received.
 */
export const mockFetch = (handler: FetchHandler) => {
  const implementation = (
    input: string,
    init: RequestInit
  ): Promise<Response> | Response => {
    const request: RecordedRequest = {
      body: String(init.body ?? ""),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      url: input,
    };
    requests.push(request);
    return handler(request, init);
  };
  // SAFETY: every call this extension makes passes a string URL and a JSON string body, so
  // the narrower implementation stands in for the global fetch during a test.
  globalThis.fetch = implementation as typeof fetch;
};

export const httpStatus = (status: number): Response =>
  status === 201
    ? Response.json(
        {
          artworkLargeUrl: null,
          artworkUrl: null,
          autoDownloadResult: "unavailable",
          createdAt: "2026-01-01T00:00:00.000Z",
          creator: null,
          creatorId: null,
          downloadState: "none",
          durationSeconds: null,
          finishCount: 0,
          id: "saved-set",
          lastListenedAt: null,
          listenCount: 0,
          metadataState: "pending",
          playbackPositionSeconds: 0,
          playlistIds: [],
          releasedAt: null,
          retainedAudioBytes: null,
          retainedAudioFormat: null,
          source: "youtube",
          tags: [],
          title: "Saved set",
          titleEditedByUser: false,
          tracklistState: "pending",
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        },
        { status }
      )
    : new Response(null, { status });
