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
import { createRequestLogger, initLogger } from "evlog";
import type { DrainContext, RequestLogger, WideEvent } from "evlog";

/**
 * Server logging is one wide event per request, emitted once when the request
 * settles. The event carries a field set chosen here — request id, method, path
 * with the query string removed, status, outcome, and elapsed time — so an
 * authorization header, cookie, or request body is never recorded.
 *
 * Effect code may also log, and those messages and annotations are bounded and
 * redacted by key name before they are folded in. Redaction follows key names,
 * not value shapes, so a credential written as free text, or under a key that
 * does not name one, can still reach a log line: logging code must treat free
 * text as public.
 */

/** A log field the server never records, so redaction only guards accidents. */
const REDACTED_PATHS = [
  "**.authorization",
  "**.cookie",
  "**.password",
  "**.secret",
  "**.token",
];

/** The leaf names above, so `token` also covers `apiToken` and `access_token`. */
const REDACTED_KEYS = REDACTED_PATHS.map((path) =>
  path.slice(path.lastIndexOf(".") + 1).toLowerCase()
);

/**
 * True for keys that name a credential at any position: `token`, `apiToken`, and
 * `access_token` all match. Over-redacting a harmless key costs a field; missing a
 * credential costs a secret, so this check is deliberately loose.
 */
const isCredentialKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return REDACTED_KEYS.some((word) => normalized.includes(word));
};

/** Bounds for logs an Effect program attaches to one request. */
const MAX_LOGGED_LINES = 50;
const MAX_MESSAGE_CHARACTERS = 500;
const MAX_LOGGED_VALUE_CHARACTERS = 200;
const MAX_LOGGED_VALUE_DEPTH = 4;
const MAX_LOGGED_VALUE_ENTRIES = 20;
const MAX_LOGGED_VALUE_NODES = 200;

const REDACTED_VALUE = "[redacted]";
const DROPPED_VALUE = "[unlogged]";

export interface LoggingOptions {
  /** Recorded as the event `environment`. Defaults to `development`. */
  readonly environment?: string;
  /**
   * Called with every emitted event. The production entrypoint leaves this unset
   * so evlog writes the event to standard output; tests use it to observe events
   * without parsing console output.
   */
  readonly onEvent?: (event: WideEvent) => void;
  /** Suppress evlog's own console output. Used by tests. */
  readonly silent?: boolean;
}

export type RequestOutcome = "success" | "rejected" | "failure" | "cancelled";

export interface RequestCompletion {
  readonly outcome: RequestOutcome;
  readonly status?: number;
}

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
  // Bun runs tests with NODE_ENV=test, so an unconfigured suite stays quiet.
  const silent = options.silent ?? process.env.NODE_ENV === "test";
  if (silent) {
    initLogger({ drain: discardEvent, env, redact, silent: true });
    return;
  }
  initLogger({ env, redact });
};

/** The path only: a query string can carry a token or a source link. */
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

/** Seals the request logger and emits its one completion event. */
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

/** The status the router would send: the response defect it turned the failure into. */
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
    // A bare interruption carries no response of its own: report it as
    // cancelled rather than inventing a status it never produced.
    return status === undefined
      ? { outcome: "cancelled" }
      : { outcome: "cancelled", status };
  }
  // A real defect with no response is the 500 the router will send.
  const failureStatus = status ?? 500;
  return { outcome: outcomeForStatus(failureStatus), status: failureStatus };
};

const CurrentRequestLog = Context.Reference<RequestLogger | null>(
  "orbis/CurrentRequestLog",
  { defaultValue: () => null }
);

const lineCounts = new WeakMap<RequestLogger, number>();

const levelOf = (logLevel: LogLevel.LogLevel): "info" | "warn" | "error" => {
  if (logLevel === "Error" || logLevel === "Fatal") {
    return "error";
  }
  return logLevel === "Warn" ? "warn" : "info";
};

/** Remaining nodes one logged value may spend, so huge or branching input stays cheap. */
interface SanitizeBudget {
  remaining: number;
}

/**
 * A logged message part, as Effect hands it over: a value with no declared type. It is
 * parsed here, once, into `LoggedValue`, and never reaches evlog unparsed.
 */
type UnparsedMessagePart = Logger.Options<unknown>["message"];

/** A record this module is willing to record, keyed by the name the logger used. */
interface LoggedRecord {
  readonly [key: string]: LoggedValue;
}

/**
 * What survives sanitizing: strings, numbers, booleans, null, undefined, and arrays and
 * plain records of those. Class instances, functions, symbols, and cycles become a
 * placeholder, so the logged structure always formats and never grows past its bounds.
 */
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

/**
 * Copies an arbitrary logged value into a plain, bounded structure whose
 * credential-named fields are replaced. The copy holds no reference to the
 * original objects, so cycles and oversized spans never reach evlog's redaction
 * walk or the formatter, and only primitives, records, and arrays survive. An
 * object with no readable entries, such as an `Error`, becomes an empty record
 * rather than leaking its non-enumerable fields.
 */
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

/**
 * Folds Effect application logs into the active request's wide event instead of
 * writing a second line to standard output. Effect log annotations, including the
 * request ones added by the middleware, ride along on each entry, and both the
 * message and the annotations are sanitized before they reach evlog.
 */
export const effectLogBridge: Logger.Logger<unknown, void> = Logger.make(
  (options: Logger.Options<unknown>) => {
    const requestLog = options.fiber.getRef(CurrentRequestLog);
    if (requestLog === null) {
      Logger.defaultLogger.log(options);
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

/**
 * Wraps the router so every routed request gets exactly one wide event. The
 * event carries the request id, method, path, status, and evlog's own elapsed
 * time, and settles on success, typed failure, defect, or interruption.
 */
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
        Effect.provideService(CurrentRequestLog, logger),
        Effect.provideService(References.CurrentLoggers, requestLoggers),
        Effect.annotateLogs({ method: request.method, path, requestId }),
        Effect.onExit((exit) =>
          Effect.sync(() =>
            finishRequestLog(logger, describeExit(exit), options)
          )
        )
      );
    });
