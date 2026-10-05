import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { backUp } from "./backup.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

const serve = (dataDirectory: string) =>
  createApp({
    databasePath: path.join(dataDirectory, "library.sqlite"),
    devicesPath: path.join(dataDirectory, "devices.json"),
    logging: { silent: true },
  });

test("a backup restores to a service that serves the same Library", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-backup-"));
  const data = path.join(root, "data");
  const scratch = path.join(root, "scratch");
  const backups = path.join(root, "backups");
  await Bun.write(path.join(data, ".keep"), "");
  await writeFile(
    path.join(data, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-09-29T00:00:00.000Z",
          id: "k",
          label: "phone",
          lastUsedAt: null,
          personId: "host",
          scope: "daily",
          tokenHash: hashToken("host-key"),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const headers = { authorization: "Bearer host-key" };
  const live = serve(data);
  try {
    const saved = await request(live, {
      accessMode: "device",
      headers,
      host: "vanta.example.ts.net",
      method: "POST",
      payload: {
        title: "Backed up Set",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    for (let day = 1; day <= 4; day += 1) {
      backUp({
        dataDirectory: data,
        keep: 3,
        now: new Date(`2026-09-0${day}T03:00:00Z`),
        outputDirectory: backups,
      });
    }
    const names = await readdir(backups);
    // oxlint-disable-next-line unicorn/no-array-sort -- The ES2022 library has no toSorted.
    const kept = names.sort((a, b) => a.localeCompare(b));
    expect(kept).toHaveLength(3);
    const latest = path.join(backups, kept.at(-1) ?? "");
    // Restore: copy the latest backup to a scratch directory and start the service on it.
    await Bun.write(
      path.join(scratch, "library.sqlite"),
      Bun.file(path.join(latest, "library.sqlite"))
    );
    expect(await Bun.file(path.join(latest, "devices.json")).exists()).toBe(
      false
    );
    const restored = serve(scratch);
    try {
      const listed = await request(restored, {
        accessMode: "device",
        headers,
        host: "vanta.example.ts.net",
        method: "GET",
        url: "/sets",
      });
      expect(listed.statusCode).toBe(200);
      expect(
        listed.json().sets.map((set: { title: string }) => set.title)
      ).toEqual(["Backed up Set"]);
    } finally {
      await restored.dispose();
    }
    new Database(path.join(latest, "library.sqlite")).close();
  } finally {
    await live.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
