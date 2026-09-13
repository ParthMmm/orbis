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

export type AccessMode = "local" | "device";

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
 * The device registry as the request path sees it. `storeError` is set instead of
 * throwing, so a caller can tell "no paired devices" from "no readable store".
 */
export interface DeviceRegistry {
  readonly devices: readonly DeviceRecord[];
  readonly storeError?: "unreadable";
}

/** A file that was never created is not a damaged store, so it stays quiet. */
const isMissingFile = (error: Error): boolean =>
  "code" in error && error.code === "ENOENT";

/**
 * Reads the trust store for the request path. A missing store is an empty registry, and a
 * store that exists but cannot be parsed is an empty registry with `storeError` set, so a
 * damaged store refuses remote clients, leaves local access alone, and says why.
 */
export const readDeviceRegistry = (
  devicesPath: string | undefined
): DeviceRegistry => {
  if (!devicesPath) {
    return { devices: [] };
  }
  try {
    return { devices: readDevicesStrict(devicesPath) };
  } catch (error) {
    if (error instanceof Error && isMissingFile(error)) {
      return { devices: [] };
    }
    return { devices: [], storeError: "unreadable" };
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
  readonly mode: AccessMode;
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
  if (input.mode === "local" && LOOPBACK_HOST.test(input.host)) {
    return { kind: "local" };
  }
  return rejected(LOCAL_ONLY, 403);
};
