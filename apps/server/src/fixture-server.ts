import { FEED_PROTOCOL, FEED_SOCKET_PATH } from "@orbis/contracts/http-api";
import type { ServerWebSocket } from "bun";

import type { createApp } from "./app.js";
import { makeFeedSockets } from "./feed-sockets.js";
import type { FeedSocketPort } from "./feed-sockets.js";
import type { FeedIdentity } from "./feed-transport.js";

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
  const { app } = options;
  const ports = new Map<ServerWebSocket<FeedIdentity>, FeedSocketPort>();
  const feed = makeFeedSockets(
    { ...app.feed.socket, subscribe: app.feed.subscribe },
    () => [...ports.values()]
  );
  const stopFeed = feed.start();
  const restored = app.feed.socket.prune([]);
  const server = Bun.serve<FeedIdentity>({
    fetch: async (request, listener) => {
      const origin = request.headers.get("origin");
      if (origin && origin !== options.allowedOrigin) {
        return Response.json(
          { message: "This browser Origin is not allowed." },
          { status: 403 }
        );
      }
      if (new URL(request.url).pathname === FEED_SOCKET_PATH) {
        await restored;
        const decision = await app.feed.socket.accept(
          request,
          options.allowedOrigin === undefined ? [] : [options.allowedOrigin]
        );
        if (decision.kind === "rejected") {
          return Response.json(
            { message: decision.message },
            { status: decision.status }
          );
        }
        if (
          listener.upgrade(request, {
            data: decision.identity,
            headers: { "sec-websocket-protocol": FEED_PROTOCOL },
          })
        ) {
          return;
        }
        await app.feed.socket.closed(decision.identity.connectionId);
        return Response.json(
          { message: "Upgrade to a WebSocket." },
          { status: 426 }
        );
      }
      if (request.method === "OPTIONS" && origin === options.allowedOrigin) {
        return new Response(null, {
          headers: corsHeaders(origin),
          status: 204,
        });
      }
      const response = await app.handler(
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
    websocket: {
      close: (socket) => {
        const port = ports.get(socket);
        ports.delete(socket);
        if (port) {
          void feed.closed(port);
        }
      },
      message: (socket, data) => {
        const port = ports.get(socket);
        if (port) {
          void feed.receive(port, String(data));
        }
      },
      open: (socket) => {
        ports.set(socket, {
          close: (code, reason) => socket.close(code, reason),
          identity: socket.data,
          send: (text) => {
            socket.send(text);
          },
        });
      },
    },
  });
  let stopping: Promise<void> | undefined;
  return {
    adminToken,
    stop: () => {
      stopping ??= (async () => {
        stopFeed();
        await Promise.all([server.stop(true), app.dispose()]);
      })();
      return stopping;
    },
    url: server.url,
  };
};
