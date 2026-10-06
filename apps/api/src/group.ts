import {
  FEED_PING,
  FEED_PONG,
  FEED_PROTOCOL,
  FEED_SOCKET_PATH,
} from "@orbis/contracts/http-api";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { createPortableApp } from "../../server/src/app-core.js";
import { releaseAudio } from "../../server/src/audio-release.js";
import { FeedSignals } from "../../server/src/feed-signals.js";
import { makeFeedSockets } from "../../server/src/feed-sockets.js";
import type { FeedSocketPort } from "../../server/src/feed-sockets.js";
import type { FeedIdentity } from "../../server/src/feed-transport.js";
import { Journal } from "../../server/src/journal.js";
import { Library } from "../../server/src/library.js";
import { Metadata } from "../../server/src/metadata.js";
import { issueStreamGrant } from "../../server/src/stream-grant-core.js";
import { TitleReviser } from "../../server/src/title-reviser.js";
import { Versos } from "../../server/src/versos.js";
import { makeAudioLayer } from "./audio.js";
import { transferRequest } from "./data-transfer.js";
import { databaseLayer } from "./database.js";
import type { Environment } from "./index.js";
import { GroupAudioNode } from "./node.js";
import { recoverAdmin } from "./recovery.js";
import { registerTrustStorage } from "./trust-storage.js";

const FEED_TAG = "feed";

const feedPort = (socket: WebSocket): FeedSocketPort => ({
  close: (code, reason) => socket.close(code, reason),
  identity: socket.deserializeAttachment() as FeedIdentity,
  send: (text) => socket.send(text),
});

export class Group extends DurableObject<Environment> {
  private readonly app;
  private readonly node: GroupAudioNode;
  private readonly feed;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    const trustPath = ctx.id.toString();
    registerTrustStorage(trustPath, ctx.storage);
    if (!/^[a-fA-F0-9]{64}$/u.test(env.STREAM_GRANT_SECRET)) {
      throw new Error("STREAM_GRANT_SECRET must encode 32 bytes as hex.");
    }
    const streamSecret = Buffer.from(env.STREAM_GRANT_SECRET, "hex");
    const database = databaseLayer(ctx.storage);
    const release = (id: string) =>
      releaseAudio(id, undefined, (releasedId) =>
        Effect.sync(() => this.node.release(releasedId))
      );
    const feedSignals = FeedSignals.make();
    const runtime = ManagedRuntime.make(
      Library.forPersonLayer("host", { releaseAudio: release }).pipe(
        Layer.provide(
          Journal.layer().pipe(
            Layer.provide(Layer.succeed(FeedSignals, feedSignals))
          )
        ),
        Layer.provideMerge(database)
      )
    );
    this.node = new GroupAudioNode(ctx, runtime, trustPath);
    this.app = createPortableApp({
      audio: makeAudioLayer(this.node),
      audioResponse: (_file, _range, setId, personId, grant) => {
        const url = new URL(
          `/api/sets/${encodeURIComponent(setId)}/audio`,
          env.AUDIO_NODE_URL
        );
        url.searchParams.set(
          "grant",
          grant ?? issueStreamGrant(streamSecret, setId, personId)
        );
        return HttpServerResponse.redirect(url.toString(), { status: 302 });
      },
      database,
      feedSignals,
      logging: { pretty: false, silent: false },
      metadata: Metadata.layer({
        youTubeApiKey: env.YOUTUBE_API_KEY,
        ytDlp: { read: this.node.readDetails },
      }),
      presence: {
        alarm: {
          cancel: () => ctx.storage.deleteAlarm(),
          set: (at) => ctx.storage.setAlarm(at),
        },
      },
      releaseAudio: release,
      streamSecret,
      titleReviser: TitleReviser.layer({ apiKey: env.OPENROUTER_API_KEY }),
      trustPath,
      versos:
        env.VERSOS_URL && env.VERSOS_API_KEY
          ? Versos.layer({
              key: Redacted.make(env.VERSOS_API_KEY),
              url: env.VERSOS_URL,
            })
          : Versos.unconfigured(),
    });
    this.feed = makeFeedSockets(
      { ...this.app.feed.socket, subscribe: this.app.feed.subscribe },
      () => ctx.getWebSockets(FEED_TAG).map(feedPort)
    );
    this.feed.start();
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(FEED_PING, FEED_PONG)
    );
    ctx.blockConcurrencyWhile(async () => {
      const response = await this.app.initialize();
      if (!response.ok) {
        throw new Error("Group database initialization failed.");
      }
      await this.app.feed.socket.restore(
        ctx
          .getWebSockets(FEED_TAG)
          .map((socket) => feedPort(socket).identity.connectionId)
      );
    });
  }

  private isFeed(socket: WebSocket) {
    return this.ctx.getTags(socket).includes(FEED_TAG);
  }

  private async acceptFeed(request: Request): Promise<Response> {
    const decision = await this.app.feed.socket.accept(request);
    if (decision.kind === "rejected") {
      return Response.json(
        { message: decision.message },
        { status: decision.status }
      );
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [FEED_TAG]);
    server.serializeAttachment(decision.identity satisfies FeedIdentity);
    return new Response(null, {
      headers: { "sec-websocket-protocol": FEED_PROTOCOL },
      status: 101,
      webSocket: client,
    });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (this.isFeed(socket)) {
      await this.feed.receive(
        feedPort(socket),
        typeof message === "string" ? message : new TextDecoder().decode(message)
      );
      return;
    }
    try {
      await this.node.message(socket, message);
    } catch {
      this.node.disconnected(socket, 1011);
    }
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    if (this.isFeed(socket)) {
      await this.feed.closed(feedPort(socket));
      return;
    }
    this.node.disconnected(socket, code);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    if (this.isFeed(socket)) {
      await this.feed.closed(feedPort(socket));
      return;
    }
    this.node.disconnected(socket, 1011);
  }

  override async alarm(): Promise<void> {
    await this.app.expirePresence();
  }

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/recovery") {
      return recoverAdmin(request, this.env, this.ctx.id.toString());
    }
    if (new URL(request.url).pathname === FEED_SOCKET_PATH) {
      return this.acceptFeed(request);
    }
    if (new URL(request.url).pathname === "/node") {
      return Promise.resolve(this.node.accept(request));
    }
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/health"
    ) {
      return this.app.initialize();
    }
    const path = new URL(request.url).pathname;
    if (path === "/import" || path === "/export") {
      return transferRequest({
        bootstrapDigest: this.env.IMPORT_NODE_KEY_DIGEST,
        request,
        storage: this.ctx.storage,
        trustPath: this.ctx.id.toString(),
      });
    }
    return this.app.handler(
      request,
      "device",
      request.headers.get("CF-Connecting-IP") ?? "unknown"
    );
  }
}
