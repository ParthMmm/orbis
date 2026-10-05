import type { createApp } from "./app.js";
import type { LoggingOptions } from "./logging.js";
import {
  finishRequestLog,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";

export type CutoverMode =
  | { readonly kind: "serve" }
  | { readonly kind: "read-only" }
  | { readonly kind: "forward"; readonly apiUrl: URL };

const audioPath = /^\/sets\/[^/]+\/audio$/u;
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
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

export const cutoverMode = (environment: {
  readonly ORBIS_READ_ONLY?: string | undefined;
  readonly ORBIS_API_FORWARD_URL?: string | undefined;
}): CutoverMode => {
  const readOnly = environment.ORBIS_READ_ONLY;
  if (readOnly !== undefined && readOnly !== "true" && readOnly !== "false") {
    throw new Error("ORBIS_READ_ONLY must be true or false.");
  }
  const target = environment.ORBIS_API_FORWARD_URL;
  if (target !== undefined && target !== "") {
    if (readOnly === "true") {
      throw new Error(
        "Read-only mode and API forwarding cannot both be enabled."
      );
    }
    const apiUrl = new URL(target);
    if (
      apiUrl.protocol !== "https:" ||
      apiUrl.username ||
      apiUrl.password ||
      apiUrl.search ||
      apiUrl.hash ||
      apiUrl.pathname !== "/api"
    ) {
      throw new Error(
        "ORBIS_API_FORWARD_URL must be an HTTPS API address ending in /api."
      );
    }
    return { apiUrl, kind: "forward" };
  }
  return { kind: readOnly === "true" ? "read-only" : "serve" };
};

export const cutoverHandler =
  (
    handler: ReturnType<typeof createApp>["handler"],
    mode: CutoverMode,
    options: {
      readonly logging?: LoggingOptions;
      readonly keyLabel?: (request: Request) => string | null;
    } = {}
  ): ReturnType<typeof createApp>["handler"] =>
  async (request, accessMode, clientAddress) => {
    const withOrigin = async (response: Response): Promise<Response> => {
      const origin = request.headers.get("origin");
      if (!origin) {
        return response;
      }
      const preflight = await handler(
        new Request(request.url, {
          headers: { origin },
          method: "OPTIONS",
        }),
        accessMode,
        clientAddress
      );
      if (preflight.headers.get("access-control-allow-origin") === origin) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.set("access-control-expose-headers", "retry-after");
        response.headers.set("vary", "origin");
      }
      return response;
    };
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      mode.kind === "serve" ||
      (mode.kind === "forward" &&
        audioPath.test(path) &&
        url.searchParams.has("grant"))
    ) {
      return handler(request, accessMode, clientAddress);
    }
    if (mode.kind === "read-only" && readMethods.has(request.method)) {
      return handler(request, accessMode, clientAddress);
    }
    const logger = startRequestLog({
      method: request.method,
      path: safeRequestPath(request.url),
      requestId: crypto.randomUUID(),
    });
    if (mode.kind === "read-only") {
      finishRequestLog(
        logger,
        { outcome: "rejected", status: 503 },
        options.logging
      );
      return withOrigin(
        Response.json(
          { message: "Orbis is moving its data. Try again shortly." },
          { headers: { "retry-after": "60" }, status: 503 }
        )
      );
    }
    logger.set({
      ingress: "funnel-forward",
      keyLabel: options.keyLabel?.(request) ?? null,
    });
    const target = new URL(mode.apiUrl);
    target.pathname = `${target.pathname}${path}`;
    target.search = new URL(request.url).search;
    const headers = new Headers(request.headers);
    headers.set("x-orbis-ingress", "funnel-forward");
    for (const name of hopHeaders) {
      headers.delete(name);
    }
    try {
      const forwarded = new Request(target, request);
      const response = await fetch(
        new Request(forwarded, { headers, redirect: "manual" }),
        { decompress: false }
      );
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
      finishRequestLog(
        logger,
        { outcome, status: response.status },
        options.logging
      );
      return response;
    } catch {
      finishRequestLog(
        logger,
        { outcome: "failure", status: 502 },
        options.logging
      );
      return withOrigin(
        Response.json(
          { message: "The Orbis API is unavailable. Try again shortly." },
          { headers: { "retry-after": "60" }, status: 502 }
        )
      );
    }
  };
