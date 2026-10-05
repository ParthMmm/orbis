import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const ORBIS_API_URL = "https://orbis.p11a.xyz/api";

export default Alchemy.Stack(
  "OrbisWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* deployWeb() {
    const web = yield* Cloudflare.Website.Vite("Web", {
      domain: "orbis.p11a.xyz",
      env: { ORBIS_API_URL, ORBIS_AUDIO_URL: Config.String("AUDIO_NODE_URL") },
    });
    const recoveryEnabled = yield* Config.Boolean("RECOVERY_ENABLED").pipe(
      Config.withDefault(false)
    );
    const hostEmail = recoveryEnabled
      ? yield* Config.String("RECOVERY_HOST_EMAIL")
      : "";
    const accessIssuer = recoveryEnabled
      ? yield* Config.String("ACCESS_ISSUER")
      : "";
    const recovery = recoveryEnabled
      ? yield* Effect.gen(function* configureRecovery() {
          const createRecoveryLogin = yield* Config.Boolean(
            "RECOVERY_CREATE_OTP"
          ).pipe(Config.withDefault(false));
          const recoveryLogin = createRecoveryLogin
            ? (yield* Cloudflare.Access.IdentityProvider("RecoveryLogin", {
                name: "Orbis recovery email",
                type: "onetimepin",
              }).pipe(retain())).identityProviderId
            : Cloudflare.Access.getIdentityProvider({
                type: "onetimepin",
              }).pipe(
                Output.map((provider) => {
                  if (!provider) {
                    throw new Error(
                      "No Cloudflare Access one-time PIN provider exists. Set RECOVERY_CREATE_OTP=true to create one."
                    );
                  }
                  return provider.identityProviderId;
                })
              );
          return yield* Cloudflare.Access.Application("Recovery", {
            allowedIdps: [recoveryLogin],
            autoRedirectToIdentity: true,
            domain: "orbis.p11a.xyz/api/recovery",
            name: "Orbis Host recovery",
            policies: [
              {
                decision: "allow",
                include: [{ email: hostEmail }],
                name: "Host email",
                precedence: 1,
              },
            ],
            sessionDuration: "15m",
            type: "self_hosted",
          });
        })
      : undefined;
    const api = yield* Cloudflare.Worker("Api", {
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      env: {
        ACCESS_AUDIENCE: recovery?.aud ?? "",
        ACCESS_ISSUER: accessIssuer,
        AUDIO_NODE_URL: Config.String("AUDIO_NODE_URL"),
        GROUP: Cloudflare.DurableObject("Group", { className: "Group" }),
        IMPORT_NODE_KEY_DIGEST: Config.String("IMPORT_NODE_KEY_DIGEST").pipe(
          Config.withDefault(""),
          Config.map(Redacted.make)
        ),
        OPENROUTER_API_KEY: Config.String("OPENROUTER_API_KEY").pipe(
          Config.withDefault(""),
          Config.map(Redacted.make)
        ),
        RECOVERY_HOST_EMAIL: hostEmail,
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
    return {
      api: api.url,
      recoveryAudience: recovery?.aud ?? "",
      url: web.url,
    };
  })
);
