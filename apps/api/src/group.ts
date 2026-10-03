import { OrbisApi } from "@orbis/contracts/http-api";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import { Database } from "../../server/src/db/service.js";
import { databaseLayer } from "./database.js";
import type { Environment } from "./index.js";

const HealthApi = HttpApi.make("OrbisGroup").add(OrbisApi.groups.system);

export class Group extends DurableObject<Environment> {
  private readonly app;

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    const system = HttpApiBuilder.group(HealthApi, "system", (handlers) =>
      Effect.gen(function* registerHealth() {
        yield* Database;
        return handlers.handle("health", () =>
          Effect.succeed({ status: "ok" as const })
        );
      })
    );
    this.app = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(HealthApi).pipe(
        Layer.provide(system),
        Layer.provide(databaseLayer(ctx.storage)),
        Layer.provide(HttpServer.layerServices)
      )
    );
    ctx.blockConcurrencyWhile(async () => {
      const response = await this.app.handler(
        new Request("http://group/health")
      );
      if (!response.ok) {
        throw new Error("Group database initialization failed.");
      }
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.app.handler(request);
  }
}
