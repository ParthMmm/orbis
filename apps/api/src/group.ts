import { DurableObject } from "cloudflare:workers";
import { Redacted } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { createPortableApp } from "../../server/src/app-core.js";
import { releaseAudio } from "../../server/src/audio-release.js";
import { Metadata } from "../../server/src/metadata.js";
import { issueStreamGrant } from "../../server/src/stream-grant-core.js";
import { TitleReviser } from "../../server/src/title-reviser.js";
import { Versos } from "../../server/src/versos.js";
import { audioLayer } from "./audio.js";
import { databaseLayer } from "./database.js";
import type { Environment } from "./index.js";
import { registerTrustStorage } from "./trust-storage.js";

export class Group extends DurableObject<Environment> {
  private readonly app;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    const trustPath = ctx.id.toString();
    registerTrustStorage(trustPath, ctx.storage);
    if (!/^[a-fA-F0-9]{64}$/u.test(env.STREAM_GRANT_SECRET)) {
      throw new Error("STREAM_GRANT_SECRET must encode 32 bytes as hex.");
    }
    const streamSecret = Buffer.from(env.STREAM_GRANT_SECRET, "hex");
    this.app = createPortableApp({
      audio: audioLayer,
      audioResponse: (_file, _range, setId, personId) => {
        const url = new URL(
          `/api/sets/${encodeURIComponent(setId)}/audio`,
          env.AUDIO_NODE_URL
        );
        url.searchParams.set(
          "grant",
          issueStreamGrant(streamSecret, setId, personId)
        );
        return HttpServerResponse.redirect(url.toString(), { status: 302 });
      },
      database: databaseLayer(ctx.storage),
      logging: { pretty: false, silent: false },
      metadata: Metadata.layer({ youTubeApiKey: env.YOUTUBE_API_KEY }),
      releaseAudio,
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
    ctx.blockConcurrencyWhile(async () => {
      const response = await this.app.handler(
        new Request("http://localhost/health")
      );
      if (!response.ok) {
        throw new Error("Group database initialization failed.");
      }
    });
  }
  override fetch(request: Request): Promise<Response> {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/health"
    ) {
      return this.app.handler(new Request("http://localhost/health"), "local");
    }
    return this.app.handler(
      request,
      "device",
      request.headers.get("CF-Connecting-IP") ?? "unknown"
    );
  }
}
