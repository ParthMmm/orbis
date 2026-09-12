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
  new Response(null, { status });
