import { afterEach, expect, test } from "bun:test";

import { ConfigProvider, Effect, Layer } from "effect";

import { Versos } from "./versos.js";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

// The Worker reads VERSOS_API_KEY. The Bun runtime must read the same name, or a key set for
// one runtime leaves the other unconfigured and every Tracklist stays pending.
test("the config layer reads the same key name as the Worker", async () => {
  const authorizations: (string | null)[] = [];
  server = Bun.serve({
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));
      return Response.json({ requestId: "request-1" });
    },
    port: 0,
  });
  const layer = Versos.layerConfig().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          VERSOS_API_KEY: "test-key",
          VERSOS_URL: server.url.toString(),
        })
      )
    )
  );
  const answer = await Effect.runPromise(
    Effect.gen(function* requestTracklist() {
      const versos = yield* Versos;
      return yield* versos.request({
        description: "A Set",
        source: "youtube",
        url: "https://example.com/set",
      });
    }).pipe(Effect.provide(layer))
  );
  expect(answer.requestId).toBe("request-1");
  expect(authorizations).toEqual(["Bearer test-key"]);
});
