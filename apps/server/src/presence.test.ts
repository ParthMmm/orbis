/* oxlint-disable no-await-in-loop -- SSE frames are observed in sequence. */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueueEventSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { startListeners } from "./listeners.js";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueueEventSchema)
);
const stream = (response: Response) => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("The event response has no stream");
  }
  const decoder = new TextDecoder();
  let pending = "";
  const read = async () => {
    while (!pending.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("The event stream closed");
      }
      pending += decoder.decode(chunk.value, { stream: true });
    }
    const boundary = pending.indexOf("\n\n");
    const frame = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return decode(
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
    );
  };
  return {
    close: () => reader.cancel(),
    /** Reads frames until a presence event satisfies `accept`; fails after `ms`. */
    presence: async (accept: (usernames: string[]) => boolean, ms = 6000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const event = await Promise.race([
          read(),
          Bun.sleep(deadline - Date.now()).then(() => null),
        ]);
        if (event?.kind === "presence") {
          const names = event.presence.map((entry) => entry.username);
          if (accept(names)) {
            return event.presence;
          }
        }
      }
      throw new Error("No matching presence event arrived");
    },
  };
};

test("Presence reaches only viewers who pass the gate and lapses when reports stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-presence-"));
  const databasePath = path.join(root, "library.sqlite");
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["a", "b", "c"].map((id) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: id,
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b", "c"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: id !== "host",
        username: id,
      })),
      version: 2,
    })
  );
  const listeners = await startListeners(
    createApp({
      databasePath,
      logging: { silent: true },
      presenceWindowMs: 3000,
    }),
    { devicePort: 0, localPort: 0 }
  );
  const address = listeners.device?.url;
  if (!address) {
    throw new Error("Device listener missing");
  }
  const call = (
    key: string,
    route: string,
    method = "GET",
    payload?:
      | { setId: string }
      | { seconds: number }
      | { see: boolean }
      | { title: string; url: string }
  ) => {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method,
    };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    return fetch(new URL(route, address), init);
  };
  const statusOf = async (...args: Parameters<typeof call>) => {
    const response = await call(...args);
    return response.status;
  };
  const opened: ReturnType<typeof stream>[] = [];
  try {
    const viewerA = stream(await call("a", "/events"));
    const viewerC = stream(await call("c", "/events"));
    opened.push(viewerA, viewerC);
    // C hides from nobody but A stops seeing C; B is later hidden from C.
    expect(
      await statusOf("c", "/people/b/filters", "PUT", { see: false })
    ).toBe(200);
    await viewerA.presence((names) => names.length === 0);

    const saved = await call("b", "/sets", "POST", {
      title: "Presence Set",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const set = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await saved.json()
    );
    const sqlite = new Database(databasePath);
    sqlite.run("UPDATE sets SET download_state = 'ready' WHERE id = ?", [
      set.id,
    ]);
    sqlite.close();
    expect(await statusOf("b", "/queue/active", "PUT", { setId: set.id })).toBe(
      200
    );
    expect(
      await statusOf("b", `/sets/${set.id}/position`, "PUT", { seconds: 5 })
    ).toBe(200);

    const seen = await viewerA.presence((names) => names.includes("b"));
    expect(seen).toMatchObject([{ personId: "b", set: { id: set.id } }]);
    // C fails the gate, so C never receives B's Presence.
    await expect(
      viewerC.presence((names) => names.includes("b"), 2500)
    ).rejects.toThrow("No matching presence event arrived");
    // B stops reporting, so the Presence lapses.
    await viewerA.presence((names) => names.length === 0);
  } finally {
    await Promise.all(opened.map((open) => open.close().catch(() => null)));
    await listeners.stop();
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);
