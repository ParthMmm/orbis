import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

test("devicesPath without a file database preserves key authentication across app restarts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-trust-options-"));
  const devicesPath = path.join(directory, "devices.json");
  const token = crypto.randomUUID();
  await writeFile(
    devicesPath,
    JSON.stringify({
      devices: [
        {
          addedAt: "2026-09-11T00:00:00.000Z",
          id: "fixture",
          label: "Fixture",
          tokenHash: hashToken(token),
        },
      ],
      version: 1,
    })
  );
  const app = createApp({ devicesPath });
  try {
    const response = await request(app, {
      accessMode: "device",
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/me",
    });
    expect(response.statusCode).toBe(200);
    expect(await readFile(`${devicesPath}.migrated`, "utf-8")).toContain(
      hashToken(token)
    );
  } finally {
    await app.dispose();
  }
  const restarted = createApp({ databasePath: ":memory:", devicesPath });
  try {
    const response = await request(restarted, {
      accessMode: "device",
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/me",
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await restarted.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
