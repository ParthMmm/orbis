import {
  Cause,
  Context,
  Effect,
  Exit,
  Formatter,
  Logger,
  References,
  Schema,
} from "effect";
import type { LogLevel } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { createLogger, createRequestLogger, initLogger } from "evlog";
import type { DrainContext, RequestLogger, WideEvent } from "evlog";

const REDACTED_PATHS = [
  "**.authorization",
  "**.cookie",
  "**.password",
  "**.secret",
  "**.token",
];

const REDACTED_KEYS = REDACTED_PATHS.map((path) =>
  path.slice(path.lastIndexOf(".") + 1).toLowerCase()
);

const isCredentialKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return REDACTED_KEYS.some((word) => normalized.includes(word));
};

const MAX_LOGGED_LINES = 50;
const MAX_MESSAGE_CHARACTERS = 500;
const MAX_LOGGED_VALUE_CHARACTERS = 200;
const MAX_LOGGED_VALUE_DEPTH = 4;
const MAX_LOGGED_VALUE_ENTRIES = 20;
const MAX_LOGGED_VALUE_NODES = 200;

const REDACTED_VALUE = "[redacted]";
const DROPPED_VALUE = "[unlogged]";

export interface LoggingOptions {
  readonly environment?: string;
  readonly onEvent?: (event: WideEvent) => void;
  readonly pretty?: boolean;
  readonly silent?: boolean;
}

export type RequestOutcome = "success" | "rejected" | "failure" | "cancelled";

export interface RequestCompletion {
  readonly outcome: RequestOutcome;
  readonly status?: number;
}

let plainLogger: Logger.Logger<unknown, void> = Logger.defaultLogger;

/** Absorbs events in silent mode: evlog warns when silent output has no drain. */
const discardEvent = (context: DrainContext): void => {
  void context;
};

/**
 * Configures evlog once for the process. evlog keeps a single process-wide
 * logger, so a second app in the same process would share this configuration;
 * the server runs one app per process, which is the only shape it supports.
 */
export const configureLogging = (options: LoggingOptions = {}): void => {
  const env = {
    environment: options.environment ?? "development",
    service: "orbis",
  };
  const redact = { paths: REDACTED_PATHS };
  const pretty = options.pretty ?? process.stdout.isTTY === true;
  plainLogger = pretty ? Logger.defaultLogger : Logger.consoleJson;
  // Bun runs tests with NODE_ENV=test, so an unconfigured suite stays quiet.
  const silent = options.silent ?? process.env.NODE_ENV === "test";
  if (silent) {
    initLogger({ drain: discardEvent, env, pretty, redact, silent: true });
    return;
  }
  initLogger({ env, pretty, redact });
};

export const safeRequestPath = (url: string): string => {
  try {
    return new URL(url, "http://orbis.local").pathname;
  } catch {
    return "/";
  }
};

export const startRequestLog = (request: {
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}): RequestLogger =>
  createRequestLogger({
    method: request.method,
    path: request.path,
    requestId: request.requestId,
  });

type EventLevel = "info" | "warn" | "error";

const levelFor = (completion: RequestCompletion): EventLevel => {
  if (completion.outcome === "failure") {
    return "error";
  }
  if (completion.outcome === "cancelled") {
    return "warn";
  }
  if (completion.status !== undefined && completion.status >= 500) {
    return "error";
  }
  if (completion.status !== undefined && completion.status >= 400) {
    return "warn";
  }
  return "info";
};

export const finishRequestLog = (
  logger: RequestLogger,
  completion: RequestCompletion,
  options: LoggingOptions = {}
): void => {
  logger.setLevel(levelFor(completion));
  const event =
    completion.status === undefined
      ? logger.emit({ outcome: completion.outcome })
      : logger.emit({ outcome: completion.outcome, status: completion.status });
  if (event !== null) {
    options.onEvent?.(event);
  }
};

const responseStatus = (cause: Cause.Cause<unknown>): number | undefined => {
  for (const reason of cause.reasons) {
    if (
      Cause.isDieReason(reason) &&
      HttpServerResponse.isHttpServerResponse(reason.defect)
    ) {
      return reason.defect.status;
    }
  }
  return undefined;
};

const outcomeForStatus = (status: number): RequestOutcome => {
  if (status >= 500) {
    return "failure";
  }
  return status >= 400 ? "rejected" : "success";
};

const describeExit = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>
): RequestCompletion => {
  if (Exit.isSuccess(exit)) {
    const { status } = exit.value;
    return { outcome: outcomeForStatus(status), status };
  }
  const status = responseStatus(exit.cause);
  if (!Exit.hasFails(exit) && Exit.hasInterrupts(exit)) {
    return status === undefined
      ? { outcome: "cancelled" }
      : { outcome: "cancelled", status };
  }
  const failureStatus = status ?? 500;
  return { outcome: outcomeForStatus(failureStatus), status: failureStatus };
};

const CurrentWideEvent = Context.Reference<RequestLogger | null>(
  "orbis/CurrentWideEvent",
  { defaultValue: () => null }
);

export const annotateForwardedRequest = (keyLabel: string | null) =>
  Effect.gen(function* forwardedRequestAnnotation() {
    const logger = yield* CurrentWideEvent;
    logger?.set({ ingress: "funnel-forward", keyLabel });
  });

const lineCounts = new WeakMap<RequestLogger, number>();

const levelOf = (logLevel: LogLevel.LogLevel): "info" | "warn" | "error" => {
  if (logLevel === "Error" || logLevel === "Fatal") {
    return "error";
  }
  return logLevel === "Warn" ? "warn" : "info";
};

interface SanitizeBudget {
  remaining: number;
}

type UnparsedMessagePart = Logger.Options<unknown>["message"];

interface LoggedRecord {
  readonly [key: string]: LoggedValue;
}

type LoggedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LoggedValue[]
  | LoggedRecord;

const isText = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);
const isObject = Schema.is(Schema.ObjectKeyword);

const sanitizeLoggedValue = (
  value: UnparsedMessagePart,
  depth: number,
  budget: SanitizeBudget
): LoggedValue => {
  budget.remaining -= 1;
  if (budget.remaining <= 0) {
    return DROPPED_VALUE;
  }
  if (value === undefined) {
    return undefined;
  }
  if (isText(value)) {
    return value.length > MAX_LOGGED_VALUE_CHARACTERS
      ? `${value.slice(0, MAX_LOGGED_VALUE_CHARACTERS)}…`
      : value;
  }
  if (isNumber(value) || isBoolean(value)) {
    return value;
  }
  if (value === null) {
    return null;
  }
  if (depth >= MAX_LOGGED_VALUE_DEPTH) {
    return DROPPED_VALUE;
  }
  if (Array.isArray(value)) {
    const items: LoggedValue[] = [];
    const limit = Math.min(value.length, MAX_LOGGED_VALUE_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      items.push(sanitizeLoggedValue(value[index], depth + 1, budget));
    }
    if (value.length > limit) {
      items.push(`…+${value.length - limit}`);
    }
    return items;
  }
  if (!isObject(value)) {
    return DROPPED_VALUE;
  }
  const record: { [key: string]: LoggedValue } = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_LOGGED_VALUE_ENTRIES) {
      record["…"] = "more";
      break;
    }
    count += 1;
    record[key] = isCredentialKey(key)
      ? REDACTED_VALUE
      : sanitizeLoggedValue(entry, depth + 1, budget);
  }
  return record;
};

const sanitizedMessage = (
  value: UnparsedMessagePart,
  budget: SanitizeBudget
): string =>
  isText(value)
    ? value
    : Formatter.format(sanitizeLoggedValue(value, 0, budget));

export const effectLogBridge: Logger.Logger<unknown, void> = Logger.make(
  (options: Logger.Options<unknown>) => {
    const requestLog = options.fiber.getRef(CurrentWideEvent);
    if (requestLog === null) {
      plainLogger.log(options);
      return;
    }
    const seen = lineCounts.get(requestLog) ?? 0;
    if (seen >= MAX_LOGGED_LINES) {
      return;
    }
    lineCounts.set(requestLog, seen + 1);
    const budget: SanitizeBudget = { remaining: MAX_LOGGED_VALUE_NODES };
    const { message } = options;
    const text = (
      Array.isArray(message)
        ? message.map((part) => sanitizedMessage(part, budget))
        : [sanitizedMessage(message, budget)]
    ).join(" ");
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const safeAnnotations: { [key: string]: LoggedValue } = {};
    let annotationCount = 0;
    for (const [key, value] of Object.entries(annotations)) {
      if (annotationCount >= MAX_LOGGED_VALUE_ENTRIES) {
        break;
      }
      annotationCount += 1;
      safeAnnotations[key] = isCredentialKey(key)
        ? REDACTED_VALUE
        : sanitizeLoggedValue(value, 0, budget);
    }
    requestLog.set({
      logs: [
        {
          ...safeAnnotations,
          level: levelOf(options.logLevel),
          message:
            text.length > MAX_MESSAGE_CHARACTERS
              ? `${text.slice(0, MAX_MESSAGE_CHARACTERS)}…`
              : text,
        },
      ],
    });
  }
);

const requestLoggers: ReadonlySet<Logger.Logger<unknown, void>> = new Set([
  effectLogBridge,
]);

export const loggingLayer = Logger.layer([effectLogBridge]);

export const makeRequestLogMiddleware =
  (options: LoggingOptions = {}) =>
  <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  > =>
    Effect.gen(function* logRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = safeRequestPath(request.url);
      const requestId = crypto.randomUUID();
      const logger = startRequestLog({
        method: request.method,
        path,
        requestId,
      });
      return yield* httpEffect.pipe(
        Effect.provideService(CurrentWideEvent, logger),
        Effect.provideService(References.CurrentLoggers, requestLoggers),
        Effect.annotateLogs({ method: request.method, path, requestId }),
        Effect.onExit((exit) =>
          Effect.sync(() =>
            finishRequestLog(logger, describeExit(exit), options)
          )
        )
      );
    });

export const withWideEvent =
  (context: Readonly<Record<string, string>>, options: LoggingOptions = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const logger = createLogger({ ...context });
      return effect.pipe(
        Effect.provideService(CurrentWideEvent, logger),
        Effect.provideService(References.CurrentLoggers, requestLoggers),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              finishRequestLog(logger, { outcome: "success" }, options);
              return;
            }
            if (Cause.hasInterruptsOnly(exit.cause)) {
              finishRequestLog(logger, { outcome: "cancelled" }, options);
              return;
            }
            const reason = Cause.squash(exit.cause);
            logger.set({
              reason: reason instanceof Error ? reason.message : "unknown",
            });
            finishRequestLog(logger, { outcome: "failure" }, options);
          })
        )
      );
    });

export const outputHead = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_VALUE_CHARACTERS
    ? `${trimmed.slice(0, MAX_LOGGED_VALUE_CHARACTERS - 1)}…`
    : trimmed;
};

export const outputTail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_LOGGED_VALUE_CHARACTERS
    ? `…${trimmed.slice(-(MAX_LOGGED_VALUE_CHARACTERS - 1))}`
    : trimmed;
};
