import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { startListeners } from "./listeners.js";

const SavedIdentity = Schema.Struct({ id: Schema.String });
const GrantResponse = Schema.Struct({ url: Schema.String });
const statusOf = async (target: URL, init?: RequestInit) => {
  const response = await fetch(target, init);
  return response.status;
};

test("device listener grants one Set's audio and rejects invalid browser credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-web-ingress-"));
  const token = "web-ingress-test-key";
  const events: unknown[] = [];
  const databasePath = path.join(directory, "library.sqlite");
  await writeFile(
    path.join(directory, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: new Date().toISOString(),
          id: "web-key",
          label: "Web test",
          lastUsedAt: null,
          personId: "host",
          scope: "daily",
          tokenHash: hashToken(token),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const app = createApp({
    audio: { audioDir: path.join(directory, "audio") },
    databasePath,
    logging: {
      environment: "test",
      onEvent: (event) => {
        events.push(event);
      },
      silent: true,
    },
  });
  const listeners = await startListeners(app, { devicePort: 0, localPort: 0 });
  try {
    const { device } = listeners;
    if (!device) {
      throw new Error("Missing device listener");
    }
    const origin = "https://orbis.p11a.xyz";
    const headers = { authorization: `Bearer ${token}`, origin };
    const save = async (title: string, url: string) => {
      const response = await fetch(new URL("/sets", device.url), {
        body: JSON.stringify({ title, url }),
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(201);
      const result: unknown = await response.json();
      return Schema.decodeUnknownSync(SavedIdentity)(result).id;
    };
    const first = await save(
      "First",
      "https://www.youtube.com/watch?v=webingress1"
    );
    const second = await save(
      "Second",
      "https://www.youtube.com/watch?v=webingress2"
    );
    await mkdir(path.join(directory, "audio"), { recursive: true });
    await writeFile(
      path.join(directory, "audio", `${first}.m4a`),
      "0123456789"
    );
    const db = new Database(databasePath);
    db.query(
      "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = 10 WHERE id = ?"
    ).run(first);
    db.close();

    const grantResponse = await fetch(
      new URL(`/sets/${first}/audio/grant`, device.url),
      { headers, method: "POST" }
    );
    expect(grantResponse.status).toBe(200);
    expect(grantResponse.headers.get("access-control-allow-origin")).toBe(
      origin
    );
    const grantResult: unknown = await grantResponse.json();
    const { url } = Schema.decodeUnknownSync(GrantResponse)(grantResult);
    const grant = new URL(url, device.url).searchParams.get("grant");
    if (!grant) {
      throw new Error("Grant URL omitted the grant");
    }
    const expiry = Number(grant.split(".")[0]);
    expect(expiry - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(expiry - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    const stream = await fetch(new URL(url, device.url), {
      headers: { origin, range: "bytes=2-5" },
    });
    expect(stream.status).toBe(206);
    expect(await stream.text()).toBe("2345");
    expect(JSON.stringify(events)).not.toContain(grant);
    const altered = new URL(url, device.url);
    altered.searchParams.set("grant", `${altered.searchParams.get("grant")}x`);
    expect(await statusOf(altered)).toBe(401);
    const otherSet = new URL(url.replace(first, second), device.url);
    expect(await statusOf(otherSet)).toBe(401);
    expect(
      await statusOf(new URL(`/sets?${altered.searchParams}`, device.url))
    ).toBe(401);
    const expired = new URL(url, device.url);
    const expiredAt = Date.now() - 1;
    const secret = await readFile(path.join(directory, "stream-grant.key"));
    const expiredSignature = createHmac("sha256", secret)
      .update(`${first}\nhost\n${expiredAt}`)
      .digest("hex");
    expired.searchParams.set("grant", `${expiredAt}.host.${expiredSignature}`);
    expect(await statusOf(expired)).toBe(401);
    expect(
      await statusOf(new URL("/health", device.url), {
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).toBe(403);
    expect(
      await statusOf(new URL("/health", listeners.local.url), { headers })
    ).toBe(403);
    const wrong = await Promise.all(
      Array.from({ length: 22 }, () =>
        fetch(new URL("/health", device.url), {
          headers: { authorization: "Bearer wrong" },
        })
      )
    );
    expect(wrong.map((response) => response.status)).toEqual([
      ...Array.from({ length: 20 }, () => 401),
      429,
      429,
    ]);
    const rejectedBrowser = await fetch(new URL("/health", device.url), {
      headers: { authorization: "Bearer wrong", origin },
    });
    expect(rejectedBrowser.status).toBe(429);
    expect(rejectedBrowser.headers.get("access-control-allow-origin")).toBe(
      origin
    );
  } finally {
    await listeners.stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("local development Origin is accepted only on the development device listener", async () => {
  const app = createApp({ allowDevelopmentOrigins: true });
  const listeners = await startListeners(app, { devicePort: 0, localPort: 0 });
  try {
    const { device } = listeners;
    if (!device) {
      throw new Error("Missing device listener");
    }
    const headers = { origin: "http://localhost:5173" };
    const allowed = await fetch(new URL("/sets", device.url), {
      headers,
      method: "OPTIONS",
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      headers.origin
    );
    expect(
      await statusOf(new URL("/sets", listeners.local.url), {
        headers,
        method: "OPTIONS",
      })
    ).toBe(403);
    expect(
      await statusOf(new URL("/sets", device.url), {
        headers: { origin: "http://evil.example:5173" },
        method: "OPTIONS",
      })
    ).toBe(403);
  } finally {
    await listeners.stop();
  }
});

test("the default device listener refuses localhost browser Origins", async () => {
  const app = createApp();
  const listeners = await startListeners(app, { devicePort: 0, localPort: 0 });
  try {
    const { device } = listeners;
    if (!device) {
      throw new Error("Missing device listener");
    }
    expect(
      await statusOf(new URL("/sets", device.url), {
        headers: { origin: "http://localhost:5173" },
        method: "OPTIONS",
      })
    ).toBe(403);
  } finally {
    await listeners.stop();
  }
});

test("device listener accepts the Cloudflare web Origin and the local listener refuses it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-web-origin-"));
  const token = "web-origin-test-key";
  await writeFile(
    path.join(directory, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: new Date().toISOString(),
          id: "web-key",
          label: "Web test",
          lastUsedAt: null,
          personId: "host",
          scope: "daily",
          tokenHash: hashToken(token),
        },
      ],
      people: [{ id: "host", removed: false, username: "host" }],
      version: 2,
    })
  );
  const app = createApp({
    audio: { audioDir: path.join(directory, "audio") },
    databasePath: path.join(directory, "library.sqlite"),
    logging: { environment: "test", silent: true },
  });
  const listeners = await startListeners(app, { devicePort: 0, localPort: 0 });
  try {
    const { device } = listeners;
    if (!device) {
      throw new Error("Missing device listener");
    }
    const origin = "https://orbis.p11a.xyz";
    const preflight = await fetch(new URL("/sets", device.url), {
      headers: {
        "access-control-request-headers": "authorization, content-type",
        "access-control-request-method": "POST",
        origin,
      },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("vary")).toBe("origin");
    const listed = (name: string) =>
      preflight.headers
        .get(name)
        ?.split(",")
        .map((value) => value.trim());
    expect(listed("access-control-allow-headers")).toEqual(
      expect.arrayContaining(["authorization", "content-type"])
    );
    expect(listed("access-control-allow-methods")).toEqual(
      expect.arrayContaining([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ])
    );

    const saved = await fetch(new URL("/sets", device.url), {
      body: JSON.stringify({
        title: "Web origin",
        url: "https://www.youtube.com/watch?v=weborigin01",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin,
      },
      method: "POST",
    });
    expect(saved.status).toBe(201);
    expect(saved.headers.get("access-control-allow-origin")).toBe(origin);
    expect(saved.headers.get("vary")).toBe("origin");

    const refused = await Promise.all(
      [
        "https://evil.example",
        "http://orbis.p11a.xyz",
        "https://orbis.p11a.xyz.evil.example",
        "https://evil.orbis.p11a.xyz",
        // The Funnel served the old web client until the cut-over (#150).
        "https://vanta.tail01d084.ts.net:10000",
      ].map((refusedOrigin) =>
        statusOf(new URL("/sets", device.url), {
          headers: { authorization: `Bearer ${token}`, origin: refusedOrigin },
          method: "POST",
        })
      )
    );
    expect(refused).toEqual([403, 403, 403, 403, 403]);
    expect(
      await statusOf(new URL("/sets", listeners.local.url), {
        headers: { origin },
        method: "OPTIONS",
      })
    ).toBe(403);
    expect(
      await statusOf(new URL("/health", listeners.local.url), {
        headers: { authorization: `Bearer ${token}`, origin },
      })
    ).toBe(403);
  } finally {
    await listeners.stop();
    await rm(directory, { force: true, recursive: true });
  }
});
