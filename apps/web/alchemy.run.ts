import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// Keep clients on Vanta until the Group implements the remaining routes (ADR 0018).
const ORBIS_API_URL = "https://vanta.tail01d084.ts.net:10000/api";

export default Alchemy.Stack(
  "OrbisWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* deployWeb() {
    const web = yield* Cloudflare.Website.Vite("Web", {
      domain: "orbis.p11a.xyz",
      env: { ORBIS_API_URL },
    });
    const api = yield* Cloudflare.Worker("Api", {
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      env: {
        AUDIO_NODE_URL: Config.String("AUDIO_NODE_URL"),
        GROUP: Cloudflare.DurableObject("Group", { className: "Group" }),
        OPENROUTER_API_KEY: Config.String("OPENROUTER_API_KEY").pipe(
          Config.withDefault(""),
          Config.map(Redacted.make)
        ),
        STREAM_GRANT_SECRET: Config.Redacted("STREAM_GRANT_SECRET"),
        VERSOS_API_KEY: Config.String("VERSOS_API_KEY").pipe(
          Config.withDefault(""),
          Config.map(Redacted.make)
        ),
        VERSOS_URL: Config.String("VERSOS_URL").pipe(Config.withDefault("")),
        YOUTUBE_API_KEY: Config.String("YOUTUBE_API_KEY").pipe(
          Config.withDefault(""),
          Config.map(Redacted.make)
        ),
      },
      main: "../api/src/index.ts",
      routes: [{ pattern: "orbis.p11a.xyz/api/*", zoneName: "p11a.xyz" }],
    });
    return { api: api.url, url: web.url };
  })
);
