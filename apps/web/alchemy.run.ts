import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

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
      compatibility: { date: "2026-07-30" },
      env: { GROUP: Cloudflare.DurableObject("Group", { className: "Group" }) },
      main: "../api/src/index.ts",
      routes: [{ pattern: "orbis.p11a.xyz/api/*", zoneName: "p11a.xyz" }],
    });
    return { api: api.url, url: web.url };
  })
);
