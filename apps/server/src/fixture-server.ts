import type { createApp } from "./app.js";

interface FixtureServerOptions {
  readonly allowedOrigin?: string;
  readonly app: ReturnType<typeof createApp>;
  readonly port?: number;
  readonly token: string;
}

interface FixtureServer {
  readonly adminToken: string;
  readonly stop: () => Promise<void>;
  readonly url: URL;
}

const corsHeaders = (origin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-origin": origin,
  vary: "origin",
});

export const startFixtureServer = (
  options: FixtureServerOptions
): FixtureServer => {
  const adminToken = options.token;
  const server = Bun.serve({
    fetch: async (request, listener) => {
      const origin = request.headers.get("origin");
      if (origin && origin !== options.allowedOrigin) {
        return Response.json(
          { message: "This browser Origin is not allowed." },
          { status: 403 }
        );
      }
      if (request.method === "OPTIONS" && origin === options.allowedOrigin) {
        return new Response(null, {
          headers: corsHeaders(origin),
          status: 204,
        });
      }
      const response = await options.app.handler(
        request,
        "device",
        listener.requestIP(request)?.address
      );
      if (origin === options.allowedOrigin) {
        for (const [name, value] of Object.entries(corsHeaders(origin))) {
          response.headers.set(name, value);
        }
      }
      return response;
    },
    hostname: "127.0.0.1",
    idleTimeout: 60,
    maxRequestBodySize: 65_536,
    port: options.port ?? 0,
  });
  let stopping: Promise<void> | undefined;
  return {
    adminToken,
    stop: () => {
      stopping ??= (async () => {
        await Promise.all([server.stop(), options.app.dispose()]);
      })();
      return stopping;
    },
    url: server.url,
  };
};
