import { Database } from "bun:sqlite";
/* oxlint-disable no-await-in-loop -- The HTTP journey observes ordered reference changes. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SavedSetSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { startFixtureServer } from "./fixture-server.js";
import { hashToken } from "./identity.js";
import { createTestApp as createApp } from "./test-app.js";

type Payload =
  | { url: string; title?: string; tags?: string[] }
  | { setId: string }
  | { setIds: string[] }
  | { seconds: number }
  | { name: string }
  | { playlistId: string };

const Id = Schema.Struct({ id: Schema.String });
const Audio = Schema.Struct({ state: Schema.String });
const failures = [
  "visible Set requires saving before playback or download",
  "hidden Set can be played, downloaded or queued by guessed ID",
  "save copies another Person's title or tags",
  "removing one reference deletes shared audio",
  "last Playlist or Queue reference leaks retained audio",
  "Listen or playback position prevents last-reference cleanup",
];

test("visible Sets share audio and storage releases only the last reference over live HTTP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-shared-audio-"));
  const audioDir = path.join(root, "audio");
  const databasePath = path.join(root, "library.sqlite");
  const evidence: string[] = [];
  const setChanges: string[] = [];
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: ["a", "b", "hidden"].map((id) => ({
        addedAt: new Date().toISOString(),
        id,
        label: id,
        lastUsedAt: null,
        personId: id,
        scope: "daily",
        tokenHash: hashToken(id),
      })),
      people: ["host", "a", "b", "hidden"].map((id) => ({
        autoDownload: false,
        id,
        removed: false,
        social: id !== "hidden",
        username: id,
      })),
      version: 2,
    })
  );
  let jobs = 0;
  const backend = Bun.serve({
    fetch(request) {
      if (new URL(request.url).pathname === "/audio") {
        return new Response(
          Bun.file(
            path.resolve(
              import.meta.dir,
              "../../../scripts/fixtures/ready-set.m4a"
            )
          )
        );
      }
      jobs += 1;
      return Response.json({
        status: "tunnel",
        url: new URL("/audio", request.url).href,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const listeners = await startFixtureServer({
    app: createApp({
      audio: {
        audioDir,
        cobaltApiKey: "test",
        cobaltUrl: backend.url.href,
        startWorker: true,
      },
      databasePath,
      feed: {
        observe: (change) => {
          if (change.topic === "set") {
            setChanges.push(change.setId);
          }
        },
      },
      logging: { silent: true },
    }),
    port: 0,
    token: "seeded-test-fixture",
  });
  const db = new Database(databasePath);
  const send = (
    key: string,
    route: string,
    method = "GET",
    payload?: Payload
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
    return fetch(new URL(route, listeners.url), init);
  };
  const status = async (...args: Parameters<typeof send>) => {
    const response = await send(...args);
    return response.status;
  };
  const save = async (key: string, suffix: string) => {
    const response = await send(key, "/sets", "POST", {
      tags: ["private"],
      title: "B's private title",
      url: `https://www.youtube.com/watch?v=${suffix}`,
    });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const set = Schema.decodeUnknownSync(SavedSetSchema)(body);
    db.query(
      "UPDATE sets SET title = 'Provider title', metadata_state = 'enriched' WHERE id = ?"
    ).run(set.id);
    return set;
  };
  const download = async (key: string, id: string) => {
    expect(await status(key, `/sets/${id}/audio/download`, "POST")).toBe(202);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await send(key, `/sets/${id}/audio/state`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (Schema.decodeUnknownSync(Audio)(body).state === "ready") {
        return;
      }
      await Bun.sleep(20);
    }
    throw new Error("Shared Download did not finish");
  };
  const retained = (id: string) =>
    Bun.file(path.join(audioDir, `${id}.m4a`)).exists();
  const playlist = async (name: string) => {
    const response = await send("a", "/playlists", "POST", { name });
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    return Schema.decodeUnknownSync(Id)(body).id;
  };
  try {
    const set = await save("b", "shared00001");
    await download("a", set.id);
    expect(jobs).toBe(1);
    expect(await status("b", `/sets/${set.id}/audio/download`, "DELETE")).toBe(
      400
    );
    for (const key of ["a", "b"]) {
      const audio = await send(key, `/sets/${set.id}/audio`);
      expect(audio.status).toBe(200);
      const bytes = await audio.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
    expect(await status("a", "/queue/active", "PUT", { setId: set.id })).toBe(
      200
    );
    expect(
      db.query("SELECT set_id FROM library_entries WHERE person_id = 'a'").all()
    ).toEqual([]);
    expect(
      await status("a", `/sets/${set.id}/position`, "PUT", { seconds: 5 })
    ).toBe(200);
    evidence.push(
      "A downloads and plays B's visible Set without a Library Entry; B plays the same bytes"
    );
    const savedResponse = await send("a", "/sets", "POST", { url: set.url });
    expect(savedResponse.status).toBe(201);
    const savedBody: unknown = await savedResponse.json();
    const saved = Schema.decodeUnknownSync(SavedSetSchema)(savedBody);
    expect(saved.title).toBe("Provider title");
    expect(saved.tags).toEqual([]);
    expect(saved.id).toBe(set.id);
    evidence.push(
      "one save creates A's entry with provider title and no copied tags"
    );
    const hidden = await save("hidden", "hidden00001");
    for (const [route, method, payload] of [
      [`/sets/${hidden.id}/audio`, "GET", undefined],
      [`/sets/${hidden.id}/audio/grant`, "POST", undefined],
      [`/sets/${hidden.id}/audio/download`, "POST", undefined],
      ["/queue/active", "PUT", { setId: hidden.id }],
    ] satisfies [string, string, Payload | undefined][]) {
      expect(await status("a", route, method, payload)).toBe(404);
    }
    evidence.push(
      "hidden audio, grant, download and Queue activation all return 404"
    );
    const list = await playlist("Retained");
    expect(
      await status("a", `/playlists/${list}/sets`, "PUT", { setIds: [set.id] })
    ).toBe(200);
    expect(await status("b", `/sets/${set.id}`, "DELETE")).toBe(200);
    expect(await retained(set.id)).toBe(true);
    expect(await status("a", `/sets/${set.id}`, "DELETE")).toBe(200);
    expect(await retained(set.id)).toBe(true);
    expect(await status("a", `/playlists/${list}`, "DELETE")).toBe(200);
    expect(await retained(set.id)).toBe(true);
    expect(
      await status("a", "/queue/completion", "POST", { setId: set.id })
    ).toBe(200);
    expect(await retained(set.id)).toBe(false);
    evidence.push(
      "Library Entry, Playlist and Queue retain bytes; final Queue completion deletes them despite Listen/position history"
    );
    for (const mode of ["delete", "replace"]) {
      const other = await save(
        "b",
        mode === "delete" ? "shared00002" : "shared00003"
      );
      await download("a", other.id);
      const id = await playlist(mode);
      expect(
        await status("a", `/playlists/${id}/sets`, "PUT", {
          setIds: [other.id],
        })
      ).toBe(200);
      expect(await status("b", `/sets/${other.id}`, "DELETE")).toBe(200);
      expect(await retained(other.id)).toBe(true);
      expect(
        await status(
          "a",
          `/playlists/${id}${mode === "replace" ? "/sets" : ""}`,
          mode === "replace" ? "PUT" : "DELETE",
          mode === "replace" ? { setIds: [] } : undefined
        )
      ).toBe(200);
      expect(await retained(other.id)).toBe(false);
    }
    evidence.push(
      "last Playlist deletion and membership replacement both release bytes"
    );
    const last = await save("b", "shared00004");
    await download("b", last.id);
    const changesBeforeRelease = setChanges.length;
    expect(await status("b", `/sets/${last.id}`, "DELETE")).toBe(200);
    expect(await retained(last.id)).toBe(false);
    expect(setChanges.slice(changesBeforeRelease)).toContain(last.id);
    evidence.push("last Library Entry releases bytes");
    evidence.push("the release journals a Set invalidation");
    const queued = await save("b", "shared00005");
    await download("a", queued.id);
    expect(
      await status("a", "/queue/active", "PUT", { setId: queued.id })
    ).toBe(200);
    expect(await status("b", `/sets/${queued.id}`, "DELETE")).toBe(200);
    expect(await retained(queued.id)).toBe(true);
    const empty = await playlist("Empty");
    expect(
      await status("a", "/queue/playlist", "PUT", { playlistId: empty })
    ).toBe(200);
    expect(await retained(queued.id)).toBe(false);
    evidence.push("replacing the final Queue reference releases bytes");
    const output = path.resolve(
      import.meta.dir,
      "../../../.cache/shared-audio"
    );
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, "http.json"),
      JSON.stringify({ evidence, failures, jobs }, null, 2)
    );
  } finally {
    db.close();
    await listeners.stop();
    backend.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
