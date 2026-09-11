import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { WideEvent } from "evlog";

import { createApp } from "./app.js";
import type { LoggingOptions } from "./logging.js";
import {
  configureLogging,
  finishRequestLog,
  makeRequestLogMiddleware,
  startRequestLog,
} from "./logging.js";
import { request } from "./test-http.js";

/** A record that points at itself, so the sanitizer has to stop on depth alone. */
interface CyclicNote {
  name: string;
  self?: CyclicNote;
}

const collect = () => {
  const events: WideEvent[] = [];
  const logging: LoggingOptions = {
    onEvent: (event) => {
      events.push(event);
    },
    silent: true,
  };
  return { events, logging };
};

const firstEvent = (events: readonly WideEvent[]): WideEvent => {
  const [event] = events;
  if (event === undefined) {
    throw new Error("expected a logged event");
  }
  return event;
};

test("records one event per request with method, safe path, status, and elapsed time", async () => {
  const { events, logging } = collect();
  const app = createApp({ logging });
  try {
    const response = await request(app, { method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    const event = firstEvent(events);
    expect(event.method).toBe("GET");
    expect(event.path).toBe("/health");
    expect(event.status).toBe(200);
    expect(event.outcome).toBe("success");
    expect(event.level).toBe("info");
    expect(event.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    );
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await app.dispose();
  }
});

test("keeps the query string and any source link out of the event", async () => {
  const { events, logging } = collect();
  const app = createApp({ logging });
  try {
    await request(app, {
      method: "GET",
      url: "/health?token=super-secret&next=https://www.youtube.com/watch?v=abcdefghijk",
    });
    const event = firstEvent(events);
    expect(event.path).toBe("/health");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("youtube.com");
  } finally {
    await app.dispose();
  }
});

test("logs a rejected request once, without the claimed device token", async () => {
  const { events, logging } = collect();
  const app = createApp({ logging });
  try {
    const response = await request(app, {
      headers: { authorization: "Bearer super-secret-device-token" },
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(401);
    expect(events).toHaveLength(1);
    const event = firstEvent(events);
    expect(event.outcome).toBe("rejected");
    expect(event.status).toBe(401);
    expect(event.level).toBe("warn");
    expect(JSON.stringify(event)).not.toContain("super-secret-device-token");
  } finally {
    await app.dispose();
  }
});

test("redacts credential-shaped values before they reach a listener", () => {
  const { events, logging } = collect();
  configureLogging(logging);
  const logger = startRequestLog({
    method: "POST",
    path: "/sets",
    requestId: "redaction-check",
  });
  logger.set({ note: "upstream rejected Bearer sk-live-abcdefghijklmnop" });
  finishRequestLog(logger, { outcome: "success", status: 201 }, logging);
  expect(events).toHaveLength(1);
  const serialized = JSON.stringify(firstEvent(events));
  expect(serialized).toContain("Bearer ***");
  expect(serialized).not.toContain("sk-live-abcdefghijklmnop");
});

test("keeps concurrent requests isolated and logs each exactly once", async () => {
  const { events, logging } = collect();
  const app = createApp({ logging });
  try {
    const paths = ["/health", "/tags", "/playlists", "/health", "/tags"];
    const responses = await Promise.all(
      paths.map((url) => request(app, { method: "GET", url }))
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(
      true
    );
    expect(events).toHaveLength(paths.length);
    const requestIds = new Set(events.map((event) => event.requestId));
    expect(requestIds.size).toBe(paths.length);
    expect(new Set(events.map((event) => event.path))).toEqual(new Set(paths));
  } finally {
    await app.dispose();
  }
});

test("emits an error event when a route dies, without leaking the error", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/boom",
      Effect.gen(function* boom() {
        yield* Effect.die(new Error("secret internal failure text"));
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    const response = await handler(new Request("http://127.0.0.1:4310/boom"));
    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    const event = firstEvent(events);
    expect(event.outcome).toBe("failure");
    expect(event.status).toBe(500);
    expect(event.level).toBe("error");
    expect(JSON.stringify(event)).not.toContain("secret internal failure text");
  } finally {
    await dispose();
  }
});

test("records a cancelled request when the handler is interrupted", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/cancel", Effect.interrupt)
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    const response = await handler(new Request("http://127.0.0.1:4310/cancel"));
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    const event = firstEvent(events);
    expect(event.outcome).toBe("cancelled");
    expect(event.status).toBe(503);
  } finally {
    await dispose();
  }
});

test("folds application logs into the request event with Effect annotations", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/logs",
      Effect.gen(function* logs() {
        yield* Effect.logInfo("loaded sets");
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    await handler(new Request("http://127.0.0.1:4310/logs"));
    expect(events).toHaveLength(1);
    const folded = JSON.stringify(firstEvent(events).logs);
    expect(folded).toContain("loaded sets");
    expect(folded).toContain("/logs");
    expect(folded).toContain("info");
  } finally {
    await dispose();
  }
});

test("calls a 500 response a failure, not a client rejection", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/broken",
      HttpServerResponse.jsonUnsafe({ message: "no" }, { status: 500 })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    const response = await handler(new Request("http://127.0.0.1:4310/broken"));
    expect(response.status).toBe(500);
    const event = firstEvent(events);
    expect(event.outcome).toBe("failure");
    expect(event.status).toBe(500);
    expect(event.level).toBe("error");
  } finally {
    await dispose();
  }
});

test("calls an unmatched route a rejection, like any other 404", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/health",
      HttpServerResponse.jsonUnsafe({ status: "ok" })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    const response = await handler(
      new Request("http://127.0.0.1:4310/missing")
    );
    expect(response.status).toBe(404);
    const event = firstEvent(events);
    expect(event.outcome).toBe("rejected");
    expect(event.status).toBe(404);
    expect(event.level).toBe("warn");
  } finally {
    await dispose();
  }
});

test("records an interrupted request with no status it never sent", () => {
  const { events, logging } = collect();
  configureLogging(logging);
  const logger = startRequestLog({
    method: "GET",
    path: "/cancel",
    requestId: "cancel-check",
  });
  finishRequestLog(logger, { outcome: "cancelled" }, logging);
  expect(events).toHaveLength(1);
  const event = firstEvent(events);
  expect(event.outcome).toBe("cancelled");
  expect(event.status).toBeUndefined();
  expect(event.level).toBe("warn");
});

test("redacts credential fields nested in a logged object", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/secret-object",
      Effect.gen(function* secretObject() {
        yield* Effect.logInfo({
          note: "upstream call",
          password: "hunter2-opaque-value",
          session: { token: "abc123opaquevalue" },
        });
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    await handler(new Request("http://127.0.0.1:4310/secret-object"));
    const folded = JSON.stringify(firstEvent(events).logs);
    expect(folded).toContain("upstream call");
    expect(folded).toContain("[redacted]");
    expect(folded).not.toContain("hunter2-opaque-value");
    expect(folded).not.toContain("abc123opaquevalue");
  } finally {
    await dispose();
  }
});

test("redacts a credential annotation and bounds oversized values", async () => {
  const { events, logging } = collect();
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/secret-annotation",
      Effect.gen(function* secretAnnotation() {
        const cyclic: CyclicNote = { name: "loop" };
        cyclic.self = cyclic;
        yield* Effect.logInfo(cyclic).pipe(
          Effect.annotateLogs({
            apiToken: "token-opaque-value",
            huge: "x".repeat(10_000),
          })
        );
        return HttpServerResponse.jsonUnsafe({ ok: true });
      })
    )
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    middleware: makeRequestLogMiddleware(logging),
  });
  try {
    await handler(new Request("http://127.0.0.1:4310/secret-annotation"));
    const serialized = JSON.stringify(firstEvent(events).logs);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("token-opaque-value");
    expect(serialized.length).toBeLessThan(4000);
  } finally {
    await dispose();
  }
});

test("reports an unreadable trust store on the rejection it causes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-logging-"));
  const devicesPath = path.join(directory, "devices.json");
  await writeFile(devicesPath, "{ not json", "utf-8");
  const { events, logging } = collect();
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
    logging,
  });
  try {
    const response = await request(app, {
      headers: { authorization: "Bearer some-device-token" },
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(401);
    const event = firstEvent(events);
    expect(event.outcome).toBe("rejected");
    expect(event.trustStore).toBe("unreadable");
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("stays quiet about a trust store that was never created", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-logging-"));
  const { events, logging } = collect();
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    logging,
  });
  try {
    const response = await request(app, {
      headers: { authorization: "Bearer some-device-token" },
      method: "GET",
      url: "/health",
    });
    expect(response.statusCode).toBe(401);
    expect(firstEvent(events).trustStore).toBeUndefined();
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("folds a saved set and its failed enrichment into one event", async () => {
  const { events, logging } = collect();
  const app = createApp({ logging });
  try {
    const response = await request(app, {
      method: "POST",
      payload: { tags: [], url: "https://youtu.be/abcdefghijk" },
      url: "/sets",
    });
    expect(response.statusCode).toBe(201);
    expect(events).toHaveLength(1);
    const event = firstEvent(events);
    expect(event.outcome).toBe("success");
    const folded = JSON.stringify(event.logs);
    expect(folded).toContain("set saved");
    expect(folded).toContain("set metadata enrichment failed");
    expect(folded).toContain("not-configured");
    // The saved set's identifier rides along, so a log line can be traced to a Set.
    expect(folded).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u
    );
  } finally {
    await app.dispose();
  }
});
