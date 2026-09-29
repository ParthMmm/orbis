import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request } from "./test-http.js";

const trust = (store: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [process.execPath, "src/trust.ts", ...args, "--devices", store],
    { cwd: path.resolve(import.meta.dir, "..") }
  );
  return {
    output: result.stdout.toString(),
    status: result.exitCode,
  };
};

const remote = (token: string) => ({
  accessMode: "device" as const,
  headers: { authorization: `Bearer ${token}` },
  host: "vanta.example.ts.net",
  method: "GET",
  url: "/me",
});

test("legacy devices become Host keys and new People can rename and revoke", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-people-"));
  const devicesPath = path.join(directory, "devices.json");
  const oldToken = "old-host-device-token";
  await writeFile(
    devicesPath,
    JSON.stringify({
      devices: [
        {
          addedAt: "2026-09-11T00:00:00.000Z",
          id: "old-device",
          label: "Host phone",
          tokenHash: hashToken(oldToken),
        },
      ],
      version: 1,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  try {
    const host = await request(app, remote(oldToken));
    expect(host.statusCode).toBe(200);
    expect(host.json()).toEqual({ id: "host", username: "host" });

    const local = await request(app, { method: "GET", url: "/me" });
    expect(local.json()).toEqual(host.json());

    const added = trust(devicesPath, "person", "add", "--username", "alice");
    expect(added.status).toBe(0);
    const storeAfterAdd = JSON.parse(await readFile(devicesPath, "utf-8"));
    const alice = storeAfterAdd.people.find(
      (person: { username: string }) => person.username === "alice"
    );
    expect(alice.id).toBeString();
    expect(storeAfterAdd.version).toBe(2);
    expect(storeAfterAdd.keys[0]).toMatchObject({
      id: "old-device",
      personId: "host",
      scope: "daily",
      tokenHash: hashToken(oldToken),
    });

    const minted = trust(
      devicesPath,
      "key",
      "add",
      "--person",
      alice.id,
      "--label",
      "Alice phone"
    );
    expect(minted.status).toBe(0);
    const token = minted.output.match(/Key token, shown once: (?<token>\S+)/u)
      ?.groups?.token;
    expect(token).toBeString();
    if (!token) {
      throw new Error("The trust command did not print the new key.");
    }

    const me = await request(app, remote(token));
    expect(me.json()).toEqual({ id: alice.id, username: "alice" });
    const renamed = await request(app, {
      ...remote(token),
      method: "PATCH",
      payload: { username: "alice-new" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ id: alice.id, username: "alice-new" });
    const renamedRead = await request(app, remote(token));
    expect(renamedRead.json()).toEqual(renamed.json());

    const storedText = await readFile(devicesPath, "utf-8");
    const stored = JSON.parse(storedText);
    const key = stored.keys.find(
      (record: { personId: string }) => record.personId === alice.id
    );
    expect(key.tokenHash).toBe(hashToken(token));
    expect(key.lastUsedAt).toBeString();
    expect(storedText).not.toContain(token);
    expect(
      stored.people.find((person: { id: string }) => person.id === alice.id)
    ).toMatchObject({ username: "alice-new" });

    expect(trust(devicesPath, "key", "revoke", "--id", key.id).status).toBe(0);
    const revoked = await request(app, remote(token));
    const stillHost = await request(app, remote(oldToken));
    expect(revoked.statusCode).toBe(401);
    expect(stillHost.statusCode).toBe(200);

    const secondKey = trust(
      devicesPath,
      "key",
      "add",
      "--person",
      alice.id,
      "--label",
      "Alice laptop"
    );
    expect(secondKey.status).toBe(0);
    const secondToken = secondKey.output.match(
      /Key token, shown once: (?<token>\S+)/u
    )?.groups?.token;
    if (!secondToken) {
      throw new Error("The trust command did not print the second key.");
    }
    const beforeRemoval = await request(app, remote(secondToken));
    expect(beforeRemoval.statusCode).toBe(200);
    expect(
      trust(devicesPath, "person", "remove", "--id", alice.id).status
    ).toBe(0);
    const afterRemoval = await request(app, remote(secondToken));
    expect(afterRemoval.statusCode).toBe(401);
    const finalStore = JSON.parse(await readFile(devicesPath, "utf-8"));
    expect(
      finalStore.people.find((person: { id: string }) => person.id === alice.id)
    ).toMatchObject({ removed: true });
    expect(
      finalStore.keys.every(
        (record: { personId: string }) => record.personId !== alice.id
      )
    ).toBe(true);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("concurrent key usage cannot restore a removed Person's keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-people-race-"));
  const devicesPath = path.join(directory, "devices.json");
  const personId = "race-person";
  const tokens = Array.from(
    { length: 80 },
    (_, index) => `race-token-${index}`
  );
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: tokens.map((token, index) => ({
        addedAt: "2026-09-11T00:00:00.000Z",
        id: `race-key-${index}`,
        label: `Race key ${index}`,
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(token),
      })),
      people: [
        { id: "host", removed: false, username: "host" },
        { id: personId, removed: false, username: "race" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
  });
  try {
    const removal = Bun.spawn(
      [
        process.execPath,
        "src/trust.ts",
        "person",
        "remove",
        "--id",
        personId,
        "--devices",
        devicesPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const responses = await Promise.all(
      tokens.map((token) => request(app, remote(token)))
    );
    expect(
      responses.every((response) =>
        [200, 401, 429].includes(response.statusCode)
      )
    ).toBe(true);
    expect(await removal.exited).toBe(0);
    const stored = JSON.parse(await readFile(devicesPath, "utf-8"));
    expect(
      stored.keys.some((key: { personId: string }) => key.personId === personId)
    ).toBe(false);
    const afterRemoval = await request(app, remote(tokens[0] ?? ""));
    expect(afterRemoval.statusCode).toBe(401);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

const waitForFile = async (file: string, attempts = 100): Promise<boolean> => {
  if (existsSync(file)) {
    return true;
  }
  if (attempts === 0) {
    return false;
  }
  await Bun.sleep(10);
  return waitForFile(file, attempts - 1);
};

test("a live lock blocks mutation and a killed owner releases it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-trust-lock-"));
  const devicesPath = path.join(directory, "devices.json");
  const marker = path.join(directory, "locked");
  const holderCode = `
    import { dlopen, FFIType } from "bun:ffi";
    import { openSync, writeFileSync } from "node:fs";
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const fd = openSync(process.env.LOCK_PATH, "a", 0o600);
    if (libc.symbols.flock(fd, 2) !== 0) process.exit(1);
    writeFileSync(process.env.MARKER_PATH, "locked");
    await Bun.sleep(30_000);
  `;
  const holder = Bun.spawn([process.execPath, "-e", holderCode], {
    env: {
      ...process.env,
      LOCK_PATH: `${devicesPath}.lock`,
      MARKER_PATH: marker,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  let mutation: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect(await waitForFile(marker)).toBe(true);
    mutation = Bun.spawn(
      [
        process.execPath,
        "src/trust.ts",
        "person",
        "add",
        "--username",
        "recovered",
        "--devices",
        devicesPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const state = await Promise.race([
      mutation.exited.then(() => "finished"),
      Bun.sleep(150).then(() => "waiting"),
    ]);
    expect(state).toBe("waiting");
    holder.kill(9);
    await holder.exited;
    expect(existsSync(`${devicesPath}.lock`)).toBe(true);
    expect(await mutation.exited).toBe(0);
    const stored = JSON.parse(await readFile(devicesPath, "utf-8"));
    expect(
      stored.people.some(
        (person: { username: string }) => person.username === "recovered"
      )
    ).toBe(true);
    expect(
      trust(devicesPath, "person", "add", "--username", "again").status
    ).toBe(0);
  } finally {
    holder.kill(9);
    mutation?.kill(9);
    await rm(directory, { force: true, recursive: true });
  }
});
