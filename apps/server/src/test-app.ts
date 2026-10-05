import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";

const token = "orbis-disposable-test-key";
const fixtureKey = {
  addedAt: "2026-01-01T00:00:00.000Z",
  id: "fixture-admin",
  label: "Test fixture",
  lastUsedAt: null,
  personId: "host",
  scope: "admin",
  tokenHash: hashToken(token),
};

export const createTestApp = (
  options: Parameters<typeof createApp>[0] = {}
): ReturnType<typeof createApp> => {
  const temporary = options.databasePath
    ? undefined
    : mkdtempSync(path.join(tmpdir(), "orbis-test-app-"));
  const databasePath =
    options.databasePath ?? path.join(temporary ?? "", "library.sqlite");
  const devicesPath =
    options.devicesPath ??
    path.join(path.dirname(databasePath), "devices.json");
  if (existsSync(devicesPath)) {
    const trust = JSON.parse(readFileSync(devicesPath, "utf-8"));
    if (trust.version === 1) {
      trust.devices.push({
        addedAt: fixtureKey.addedAt,
        id: fixtureKey.id,
        label: fixtureKey.label,
        tokenHash: fixtureKey.tokenHash,
      });
    } else {
      trust.keys.push(fixtureKey);
    }
    writeFileSync(devicesPath, JSON.stringify(trust));
  } else {
    writeFileSync(
      devicesPath,
      JSON.stringify({
        keys: [fixtureKey],
        people: [{ id: "host", removed: false, username: "host" }],
        version: 2,
      })
    );
  }
  const app = createApp({ ...options, databasePath, devicesPath });
  return {
    ...app,
    dispose: async () => {
      await app.dispose();
      if (temporary) {
        rmSync(temporary, { force: true, recursive: true });
      }
    },
    handler: (request, _mode, clientAddress) => {
      const headers = new Headers(request.headers);
      if (
        headers.get("x-orbis-test-auth") === "fixture" &&
        !headers.has("authorization")
      ) {
        headers.delete("x-orbis-test-auth");
        headers.set("authorization", `Bearer ${token}`);
      }
      return app.handler(
        new Request(request, { headers }),
        "device",
        clientAddress
      );
    },
  };
};
