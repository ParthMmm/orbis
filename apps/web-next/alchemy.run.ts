import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// The API stays on Vanta behind the Funnel; the browser calls it directly (ADR 0015).
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
    return { url: web.url };
  })
);
