import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const ORBIS_API_URL = "https://orbis.p11a.xyz/api";

const SECRETS = [
  "IMPORT_NODE_KEY_DIGEST",
  "OPENROUTER_API_KEY",
  "STREAM_GRANT_SECRET",
  "VERSOS_API_KEY",
  "YOUTUBE_API_KEY",
] as const;

const readSecret = Effect.fn(function* readSecret(name: string) {
  const value = yield* Config.option(Config.String(name));
  return value.pipe(Option.filter((text) => text !== ""));
});

export default Alchemy.Stack(
  "OrbisWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* deployWeb() {
    const secrets: Record<string, Redacted.Redacted<string>> = {};
    const kept: string[] = [];
    for (const name of SECRETS) {
      const value = yield* readSecret(name);
      if (Option.isSome(value)) {
        secrets[name] = Redacted.make(value.value);
      } else {
        kept.push(name);
      }
    }
    const web = yield* Cloudflare.Website.Vite("Web", {
      domain: "orbis.p11a.xyz",
      env: { ORBIS_API_URL, ORBIS_AUDIO_URL: Config.String("AUDIO_NODE_URL") },
    });
    const api = yield* Cloudflare.Worker("Api", {
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      env: {
        AUDIO_NODE_URL: Config.String("AUDIO_NODE_URL"),
        GROUP: Cloudflare.DurableObject("Group", { className: "Group" }),
        VERSOS_URL: Config.String("VERSOS_URL").pipe(
          Config.withDefault("https://versos.studio")
        ),
        ...secrets,
      },
      main: "../api/src/index.ts",
      // The Group writes one wide event per request to the console; persisted
      // Workers Logs keep them queryable after live tail ends.
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true, persist: true },
      },
      routes: [{ pattern: "orbis.p11a.xyz/api/*", zoneName: "p11a.xyz" }],
    });
    // An unset secret keeps the value already on Cloudflare, so a deploy needs
    // only the secrets it changes.
    for (const name of kept) {
      yield* api.bind`${name}`({ bindings: [{ name, type: "inherit" }] });
    }
    return {
      api: api.url,
      url: web.url,
    };
  })
);
