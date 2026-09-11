import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { Schema } from "effect";

/**
 * A paired device. The host stores only the digest of the device token, so a copy of
 * the trust store cannot be used to authenticate against the library.
 */
const Device = Schema.Struct({
  addedAt: Schema.String,
  id: Schema.String,
  label: Schema.String,
  tokenHash: Schema.String,
});

export type DeviceRecord = typeof Device.Type;

const TrustFile = Schema.Struct({
  devices: Schema.Array(Device),
  version: Schema.Number,
});

export type AccessDecision =
  | { readonly kind: "local" }
  | { readonly kind: "device"; readonly deviceId: string }
  | {
      readonly kind: "rejected";
      readonly message: string;
      readonly statusCode: number;
    };

const LOCAL_ONLY = "Only local app requests are allowed.";
const NOT_PAIRED = "This device is not paired with your library.";
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u;
const BEARER = /^Bearer[ \t]+(?<token>.+)$/iu;

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf-8").digest("hex");

/**
 * Reads the trust store and fails loudly. Used by the enrolment tool, which must never
 * overwrite a store it could not parse.
 */
export const readDevicesStrict = (
  devicesPath: string
): readonly DeviceRecord[] => {
  const raw: unknown = JSON.parse(readFileSync(devicesPath, "utf-8"));
  return Schema.decodeUnknownSync(TrustFile)(raw).devices;
};

/**
 * Reads the trust store for the request path. Any failure, including a missing or malformed
 * file, is an empty registry, so a damaged store refuses remote clients and leaves local
 * access alone.
 */
export const readDevices = (
  devicesPath: string | undefined
): readonly DeviceRecord[] => {
  if (!devicesPath) {
    return [];
  }
  try {
    return readDevicesStrict(devicesPath);
  } catch {
    return [];
  }
};

const matchesTokenHash = (storedHash: string, presented: string): boolean => {
  const stored = Buffer.from(storedHash, "hex");
  const digest = Buffer.from(hashToken(presented), "hex");
  return stored.length === digest.length && timingSafeEqual(stored, digest);
};

const rejected = (message: string, statusCode: number): AccessDecision => ({
  kind: "rejected",
  message,
  statusCode,
});

/**
 * The single access decision. Order matters. A browser is refused first, a claimed device
 * token is judged second, and the loopback rule the desktop client relies on is the
 * fallback, so a request from the Electron main process behaves exactly as before.
 */
export const decideAccess = (input: {
  readonly authorization: string | null;
  readonly devices: readonly DeviceRecord[];
  readonly hasOrigin: boolean;
  readonly host: string;
}): AccessDecision => {
  if (input.hasOrigin) {
    return rejected(LOCAL_ONLY, 403);
  }
  if (input.authorization !== null) {
    const token = BEARER.exec(input.authorization)?.groups?.token;
    const device = token
      ? input.devices.find((candidate) =>
          matchesTokenHash(candidate.tokenHash, token)
        )
      : undefined;
    return device
      ? { deviceId: device.id, kind: "device" }
      : rejected(NOT_PAIRED, 401);
  }
  if (LOOPBACK_HOST.test(input.host)) {
    return { kind: "local" };
  }
  return rejected(LOCAL_ONLY, 403);
};
