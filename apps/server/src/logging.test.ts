import { expect, test } from "bun:test";

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { WideEvent } from "evlog";

import type { LoggingOptions } from "./logging.js";
import {
  configureLogging,
  finishRequestLog,
  makeRequestLogMiddleware,
  startRequestLog,
} from "./logging.js";
import { createTestApp as createApp } from "./test-app.js";
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
