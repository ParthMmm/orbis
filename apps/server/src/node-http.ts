import type { LoggingOptions } from "./logging.js";
import {
  finishRequestLog,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";
import { makeNodeAudioHandler } from "./node-audio-http.js";

interface NodeHttpOptions {
  readonly apiUrl: URL;
  readonly audioDir: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly logging?: LoggingOptions;
  readonly streamSecret: Buffer;
}

const audioPath = /^\/(?:api\/)?sets\/[^/]+\/audio$/u;
const hopHeaders = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const isGrantedAudioRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    audioPath.test(url.pathname) &&
    url.searchParams.has("grant")
  );
};

const forwardApiRequest = async (
  request: Request,
  apiUrl: URL,
  requestFetch: typeof globalThis.fetch,
  logging?: LoggingOptions
): Promise<Response> => {
  const logger = startRequestLog({
    method: request.method,
    path: safeRequestPath(request.url),
    requestId: crypto.randomUUID(),
  });
  logger.set({ ingress: "funnel-forward", keyLabel: null });
  const source = new URL(request.url);
  const target = new URL(apiUrl);
  const pathname = source.pathname.startsWith("/api")
    ? source.pathname.slice(4) || "/"
    : source.pathname;
  target.pathname = `${target.pathname}${pathname}`;
  target.search = source.search;
  const headers = new Headers(request.headers);
  headers.set("x-orbis-ingress", "funnel-forward");
  for (const name of hopHeaders) {
    headers.delete(name);
  }
  try {
    const forwarded = new Request(target, request);
    const prepared = new Request(forwarded, { headers, redirect: "manual" });
    const response =
      requestFetch === globalThis.fetch
        ? await Bun.fetch(prepared, { decompress: false })
        : await requestFetch(prepared);
    const keyLabel = response.headers.get("x-orbis-key-label");
    if (keyLabel) {
      logger.set({ keyLabel: decodeURIComponent(keyLabel) });
    }
    response.headers.delete("x-orbis-key-label");
    let outcome: "failure" | "rejected" | "success" = "success";
    if (response.status >= 500) {
      outcome = "failure";
    } else if (response.status >= 400) {
      outcome = "rejected";
    }
    finishRequestLog(logger, { outcome, status: response.status }, logging);
    return response;
  } catch {
    finishRequestLog(logger, { outcome: "failure", status: 502 }, logging);
    return Response.json(
      { message: "The Orbis API is unavailable. Try again shortly." },
      { headers: { "retry-after": "60" }, status: 502 }
    );
  }
};

export const makeNodeHttpHandler = (options: NodeHttpOptions) => {
  const audio = makeNodeAudioHandler(options);
  const { apiUrl, fetch: requestFetch = globalThis.fetch, logging } = options;
  return (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (
      isGrantedAudioRequest(request) ||
      (audioPath.test(pathname) && !pathname.startsWith("/api/"))
    ) {
      return audio(request);
    }
    return forwardApiRequest(request, apiUrl, requestFetch, logging);
  };
};
