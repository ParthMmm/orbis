import { Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessConfiguration {
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_ISSUER?: string;
  readonly RECOVERY_HOST_EMAIL?: string;
}

const AccessIdentity = Schema.Struct({
  email: Schema.String,
  type: Schema.Literal("app"),
});

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const authorizedRecovery = async (
  request: Request,
  env: AccessConfiguration
): Promise<boolean> => {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  const issuer = env.ACCESS_ISSUER;
  const audience = env.ACCESS_AUDIENCE;
  const email = env.RECOVERY_HOST_EMAIL?.trim().toLowerCase();
  if (
    !assertion ||
    !issuer ||
    !audience ||
    !email ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer)
  ) {
    return false;
  }
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
    });
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      algorithms: ["RS256"],
      audience,
      issuer,
      requiredClaims: ["exp", "iat", "sub", "email", "type"],
    });
    const identity = Schema.decodeUnknownSync(AccessIdentity)(payload);
    return identity.email.toLowerCase() === email;
  } catch {
    return false;
  }
};

export const accessDenied = () =>
  Response.json(
    { message: "Sign in through Cloudflare Access to recover Host access." },
    { headers: { "cache-control": "no-store" }, status: 401 }
  );
