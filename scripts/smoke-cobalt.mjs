import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* oxlint-disable func-style, anti-slop/no-runtime-typeof */

export const COBALT_IMAGE =
  "ghcr.io/imputnet/cobalt:11@sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b";
export const COBALT_IMAGE_INDEX_DIGEST =
  "sha256:63186dd68afd57ce3bb1f62cc4c139f5fa95b9c3e87a3cf5c6e4c7a570523f62";
export const COBALT_VERSION = "11";
export const DURATION_LIMIT_SECONDS = 21_600;
export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_DURATION_TOLERANCE_SECONDS = 60;
export const DEFAULT_INTERRUPT_AFTER_BYTES = 1024 ** 2;
export const EXPECTED_SERVICES = ["soundcloud", "youtube"];

const INVALID_API_KEY = "00000000-0000-4000-8000-000000000001";
const AUTH_ERROR_CODES = new Set([
  "error.api.auth.key.invalid",
  "error.api.auth.key.missing",
  "error.api.auth.key.not_found",
  "error.api.auth.not_configured",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const CHILD_KILL_GRACE_MS = 1000;

export class SmokeError extends Error {
  constructor(code, { detail, status = "failed" } = {}) {
    super(code);
    this.name = "SmokeError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function usage() {
  return `Usage:
  node scripts/smoke-cobalt.mjs --endpoint <url> --api-key-env <name> \\
    --sample 'youtube|<url>|<seconds>' \\
    --sample 'soundcloud|<url>|<seconds>' \\
    --invalid-url <unsupported-url> --report <path>

Options:
  --api-key-env <name>             Read the API key from an environment variable.
  --api-key-stdin                  Read the API key from stdin without echoing it.
  --sample <source|url|seconds>    Repeat for approved sample fixtures.
  --invalid-url <url>              Public unsupported URL used for the error check.
  --report <path>                  Sanitized JSON evidence path, or - for stdout.
  --operator-host <name>            Host name to record in the report.
  --processing-timeout-ms <n>      Processing request timeout (default: ${DEFAULT_PROCESSING_TIMEOUT_MS}).
  --download-timeout-ms <n>        Tunnel download timeout (default: ${DEFAULT_DOWNLOAD_TIMEOUT_MS}).
  --probe-timeout-ms <n>           FFprobe timeout (default: ${DEFAULT_PROBE_TIMEOUT_MS}).
  --max-bytes <n>                  Maximum output size (default: ${DEFAULT_MAX_BYTES}).
  --duration-tolerance-seconds <n> Duration comparison tolerance (default: ${DEFAULT_DURATION_TOLERANCE_SECONDS}).
  --interrupt-after-bytes <n>      Cancel the long sample after this many bytes (default: ${DEFAULT_INTERRUPT_AFTER_BYTES}).
  --ffprobe-bin <path>             FFprobe executable (default: ffprobe).
  --ffmpeg-bin <path>              FFmpeg executable (default: ffmpeg).
  --temp-root <path>               Temporary parent directory (for operators or tests).
  --help                           Show this help.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new SmokeError(`${flag} needs a value`, { status: "usage" });
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new SmokeError(`${flag} must be a positive integer`, {
      status: "usage",
    });
  }
  return number;
}

function parseSample(value) {
  const firstSeparator = value.indexOf("|");
  const lastSeparator = value.lastIndexOf("|");
  if (
    firstSeparator <= 0 ||
    lastSeparator <= firstSeparator ||
    lastSeparator === value.length - 1
  ) {
    throw new SmokeError(
      "--sample must use source|url|expected-seconds format",
      { status: "usage" }
    );
  }

  const source = value.slice(0, firstSeparator).toLowerCase();
  const url = value.slice(firstSeparator + 1, lastSeparator);
  const expectedDurationSeconds = Number(value.slice(lastSeparator + 1));
  if (
    !Number.isFinite(expectedDurationSeconds) ||
    expectedDurationSeconds <= 0
  ) {
    throw new SmokeError("sample duration must be a positive number", {
      status: "usage",
    });
  }

  return { expectedDurationSeconds, source, url };
}

// The CLI has one branch per supported option.
// eslint-disable-next-line complexity
export function parseArgs(argv) {
  const options = {
    apiKeyEnv: undefined,
    apiKeyStdin: false,
    downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    durationToleranceSeconds: DEFAULT_DURATION_TOLERANCE_SECONDS,
    endpoint: undefined,
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    interruptAfterBytes: DEFAULT_INTERRUPT_AFTER_BYTES,
    invalidUrl: undefined,
    maxBytes: DEFAULT_MAX_BYTES,
    operatorHost: hostname(),
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    processingTimeoutMs: DEFAULT_PROCESSING_TIMEOUT_MS,
    report: undefined,
    samples: [],
    tempRoot: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
      case "-h": {
        return { help: true };
      }
      case "--endpoint": {
        options.endpoint = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--api-key-env": {
        options.apiKeyEnv = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--api-key-stdin": {
        options.apiKeyStdin = true;
        break;
      }
      case "--sample": {
        options.samples.push(parseSample(requireValue(argv, index, argument)));
        index += 1;
        break;
      }
      case "--invalid-url": {
        options.invalidUrl = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--report": {
        options.report = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--operator-host": {
        options.operatorHost = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--processing-timeout-ms": {
        options.processingTimeoutMs = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--download-timeout-ms": {
        options.downloadTimeoutMs = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--probe-timeout-ms": {
        options.probeTimeoutMs = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--max-bytes": {
        options.maxBytes = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--duration-tolerance-seconds": {
        options.durationToleranceSeconds = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--interrupt-after-bytes": {
        options.interruptAfterBytes = parsePositiveInteger(
          requireValue(argv, index, argument),
          argument
        );
        index += 1;
        break;
      }
      case "--ffprobe-bin": {
        options.ffprobeBin = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--ffmpeg-bin": {
        options.ffmpegBin = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      case "--temp-root": {
        options.tempRoot = requireValue(argv, index, argument);
        index += 1;
        break;
      }
      default: {
        throw new SmokeError(`unknown option: ${argument}`);
      }
    }
  }

  if (options.apiKeyEnv && options.apiKeyStdin) {
    throw new SmokeError("choose --api-key-env or --api-key-stdin, not both");
  }
  if (!options.apiKeyEnv && !options.apiKeyStdin) {
    throw new SmokeError("supply --api-key-env or --api-key-stdin");
  }
  if (
    options.apiKeyEnv &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.apiKeyEnv)
  ) {
    throw new SmokeError("--api-key-env must name an environment variable");
  }
  if (!options.endpoint) {
    throw new SmokeError("--endpoint is required");
  }
  if (!options.invalidUrl) {
    throw new SmokeError("--invalid-url is required");
  }
  if (!options.report) {
    throw new SmokeError("--report is required");
  }
  if (options.samples.length === 0) {
    throw new SmokeError("at least one --sample is required");
  }

  // Validation is kept below parsing so every option is normalized in one place.
  // eslint-disable-next-line no-use-before-define
  return validateOptions(options);
}

function isHostForDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function sourceForUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (isHostForDomain(host, "youtube.com") || host === "youtu.be") {
    return "youtube";
  }
  if (isHostForDomain(host, "soundcloud.com")) {
    return "soundcloud";
  }
}

function publicPathname(parsed) {
  return parsed.pathname
    .split("/")
    .map((segment) =>
      /^s-[A-Za-z0-9_-]+$/u.test(segment) ? "s-<redacted>" : segment
    )
    .join("/");
}

function sampleIdentity(sample) {
  const parsed = new URL(sample.url);
  return `${sample.source}://${parsed.hostname.toLowerCase()}${publicPathname(parsed) || "/"}`;
}

function validateEndpoint(rawEndpoint) {
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new SmokeError("--endpoint must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new SmokeError("--endpoint must use HTTP or HTTPS");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new SmokeError(
      "--endpoint must not contain credentials, query, or hash"
    );
  }
  if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
    throw new SmokeError("--endpoint must point to the Cobalt API root");
  }
  return `${endpoint.origin}/`;
}

function validateExternalUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SmokeError(`${label} must be a valid HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new SmokeError(`${label} must be an HTTP(S) URL without credentials`);
  }
  return parsed;
}

function validateOptions(options) {
  options.endpoint = validateEndpoint(options.endpoint);
  const invalidUrl = validateExternalUrl(options.invalidUrl, "--invalid-url");
  if (sourceForUrl(invalidUrl.href)) {
    throw new SmokeError(
      "--invalid-url must not be a YouTube or SoundCloud URL"
    );
  }

  for (const sample of options.samples) {
    if (!EXPECTED_SERVICES.includes(sample.source)) {
      throw new SmokeError(
        `sample source must be one of: ${EXPECTED_SERVICES.join(", ")}`
      );
    }
    validateExternalUrl(sample.url, "sample URL");
    if (sourceForUrl(sample.url) !== sample.source) {
      throw new SmokeError(
        `sample URL does not match its declared ${sample.source} source`
      );
    }
    if (sample.expectedDurationSeconds > DURATION_LIMIT_SECONDS) {
      throw new SmokeError(
        `sample duration cannot exceed ${DURATION_LIMIT_SECONDS} seconds`
      );
    }
    sample.identity = sampleIdentity(sample);
  }

  options.invalidUrl = invalidUrl.href;
  options.operatorHost = options.operatorHost.trim();
  if (!options.operatorHost) {
    throw new SmokeError("--operator-host cannot be empty");
  }
  if (options.report !== "-") {
    options.report = path.resolve(options.report);
  }
  if (options.tempRoot) {
    options.tempRoot = path.resolve(options.tempRoot);
  }
  return options;
}

export async function readApiKey(options) {
  let key;
  if (options.apiKeyEnv) {
    key = process.env[options.apiKeyEnv];
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    key = Buffer.concat(
      chunks.map((chunk) =>
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      )
    ).toString("utf-8");
  }
  key = key?.trim();
  if (!key) {
    throw new SmokeError("the supplied API key is empty");
  }
  if (!UUID_PATTERN.test(key)) {
    throw new SmokeError("the supplied API key is not a UUIDv4 key");
  }
  return key;
}

function endpointUrl(endpoint, pathname) {
  return new URL(pathname, endpoint).href;
}

function resultPassed(details = {}) {
  return { status: "passed", ...details };
}

function resultFailed(reason, details = {}) {
  return { reason, status: "failed", ...details };
}

function resultBlocked(reason, details = {}) {
  return { reason, status: "blocked", ...details };
}

function resultFromError(error) {
  if (error instanceof SmokeError) {
    return error.status === "blocked"
      ? resultBlocked(error.code)
      : resultFailed(error.code);
  }
  return resultFailed("unexpected_failure");
}

async function withDeadline(parentSignal, timeoutMs, operation) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const abortFromParent = () => controller.abort();
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof SmokeError) {
      throw error;
    }
    if (parentSignal.aborted) {
      throw new SmokeError("interrupted");
    }
    if (timedOut) {
      throw new SmokeError("timeout");
    }
    throw new SmokeError("network_error");
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

async function readBoundedText(response) {
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      // The stream must be consumed in order to enforce the byte limit.
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) {
        chunks.push(decoder.decode());
        return chunks.join("");
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        // Cancel before reporting the bound so an oversized response is not
        // left running in the background.
        // eslint-disable-next-line no-await-in-loop
        await reader.cancel();
        throw new SmokeError("response_too_large");
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponse(response) {
  if (response.body) {
    await Promise.allSettled([response.body.cancel()]);
  }
}

function requestJson(url, init, parentSignal, timeoutMs) {
  return withDeadline(parentSignal, timeoutMs, async (signal) => {
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response);
      return { httpStatus: response.status, redirect: true };
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
      await cancelResponse(response);
      throw new SmokeError("response_too_large");
    }
    const text = await readBoundedText(response);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SmokeError("malformed_response");
    }
    return { httpStatus: response.status, payload, redirect: false };
  });
}

function safeCobaltCode(payload) {
  const code = payload?.error?.code;
  return typeof code === "string" && /^[a-z0-9._-]+$/iu.test(code)
    ? code
    : "cobalt_error_unknown";
}

function statusReason(status) {
  if (typeof status !== "string" || !status) {
    return "malformed_response";
  }
  const normalized = status.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_");
  return `unexpected_status_${normalized}`;
}

function validateTunnelUrl(rawUrl, endpointOrigin) {
  let tunnelUrl;
  try {
    tunnelUrl = new URL(rawUrl);
  } catch {
    throw new SmokeError("malformed_tunnel_url");
  }
  if (tunnelUrl.username || tunnelUrl.password) {
    throw new SmokeError("tunnel_contains_credentials");
  }
  if (tunnelUrl.origin !== endpointOrigin) {
    throw new SmokeError("tunnel_origin_mismatch");
  }
  if (tunnelUrl.pathname !== "/tunnel") {
    throw new SmokeError("tunnel_path_invalid");
  }
  return tunnelUrl.href;
}

async function processRequest({
  apiKey,
  endpoint,
  parentSignal,
  sourceUrl,
  timeoutMs,
}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Api-Key ${apiKey}`;
  }
  const response = await requestJson(
    endpointUrl(endpoint, "/"),
    {
      body: JSON.stringify({
        alwaysProxy: true,
        audioFormat: "best",
        downloadMode: "audio",
        localProcessing: "disabled",
        url: sourceUrl,
      }),
      headers,
      method: "POST",
    },
    parentSignal,
    timeoutMs
  );

  if (response.redirect) {
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: "unexpected_redirect",
    };
  }
  if (
    !response.payload ||
    typeof response.payload !== "object" ||
    Array.isArray(response.payload)
  ) {
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: "malformed_response",
    };
  }
  if (response.payload.status === "error") {
    return {
      code: safeCobaltCode(response.payload),
      httpStatus: response.httpStatus,
      kind: "cobalt_error",
    };
  }
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: `http_error_${response.httpStatus}`,
    };
  }
  if (response.payload.status !== "tunnel") {
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: statusReason(response.payload.status),
    };
  }
  if (typeof response.payload.url !== "string") {
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: "malformed_response",
    };
  }

  try {
    return {
      filenamePresent: typeof response.payload.filename === "string",
      httpStatus: response.httpStatus,
      kind: "tunnel",
      tunnelUrl: validateTunnelUrl(
        response.payload.url,
        new URL(endpoint).origin
      ),
    };
  } catch (error) {
    if (error instanceof SmokeError) {
      return {
        httpStatus: response.httpStatus,
        kind: "failure",
        reason: error.code,
      };
    }
    return {
      httpStatus: response.httpStatus,
      kind: "failure",
      reason: "malformed_tunnel_url",
    };
  }
}

async function fetchInstanceInfo(options, parentSignal) {
  const response = await requestJson(
    endpointUrl(options.endpoint, "/"),
    { headers: { Accept: "application/json" }, method: "GET" },
    parentSignal,
    options.processingTimeoutMs
  );
  if (response.redirect) {
    throw new SmokeError("unexpected_redirect");
  }
  if (response.httpStatus !== 200) {
    throw new SmokeError(`health_http_${response.httpStatus}`);
  }
  const cobalt = response.payload?.cobalt;
  const services = cobalt?.services;
  if (
    !cobalt ||
    typeof cobalt !== "object" ||
    !Array.isArray(services) ||
    services.some((service) => typeof service !== "string")
  ) {
    throw new SmokeError("malformed_response");
  }
  return {
    apiUrl: typeof cobalt.url === "string" ? cobalt.url : null,
    services: services.map((service) => service.toLowerCase()).toSorted(),
    version: typeof cobalt.version === "string" ? cobalt.version : null,
  };
}

function sameOrigin(rawUrl, endpoint) {
  try {
    const parsed = new URL(rawUrl);
    return (
      !parsed.username &&
      !parsed.password &&
      parsed.origin === new URL(endpoint).origin
    );
  } catch {
    return false;
  }
}

function checkReportedApiUrl(reportedUrl, endpoint) {
  if (typeof reportedUrl !== "string") {
    return resultFailed("api_url_missing");
  }
  return sameOrigin(reportedUrl, endpoint)
    ? resultPassed({ observedApiUrl: new URL(reportedUrl).origin })
    : resultFailed("api_url_mismatch");
}

function checkServices(services) {
  if (!services) {
    return resultBlocked("instance_info_unavailable");
  }
  return JSON.stringify(services) === JSON.stringify(EXPECTED_SERVICES)
    ? resultPassed({ observedServices: services })
    : resultFailed("service_scope_mismatch", { observedServices: services });
}

async function checkAuthorization(
  label,
  sample,
  apiKey,
  options,
  parentSignal
) {
  try {
    const response = await processRequest({
      apiKey,
      endpoint: options.endpoint,
      parentSignal,
      sourceUrl: sample.url,
      timeoutMs: options.processingTimeoutMs,
    });
    if (
      response.kind === "cobalt_error" &&
      AUTH_ERROR_CODES.has(response.code)
    ) {
      return resultPassed({
        errorCode: response.code,
        httpStatus: response.httpStatus,
      });
    }
    if (response.httpStatus === 401 || response.httpStatus === 403) {
      return resultPassed({ httpStatus: response.httpStatus });
    }
    return resultFailed(`${label}_not_rejected`, {
      errorCode: response.code,
      httpStatus: response.httpStatus,
    });
  } catch (error) {
    return resultFromError(error);
  }
}

async function checkInvalidSource(sample, apiKey, options, parentSignal) {
  try {
    const response = await processRequest({
      apiKey,
      endpoint: options.endpoint,
      parentSignal,
      sourceUrl: options.invalidUrl,
      timeoutMs: options.processingTimeoutMs,
    });
    if (response.kind === "cobalt_error") {
      return resultPassed({
        errorCode: response.code,
        httpStatus: response.httpStatus,
      });
    }
    return resultFailed("invalid_source_accepted", {
      httpStatus: response.httpStatus,
    });
  } catch (error) {
    return resultFromError(error);
  }
}

function audioExtension(contentType) {
  const type = contentType?.split(";", 1)[0].toLowerCase();
  if (type === "audio/mpeg") {
    return "mp3";
  }
  if (type === "audio/ogg") {
    return "ogg";
  }
  if (type === "audio/wav" || type === "audio/x-wav") {
    return "wav";
  }
  if (type === "audio/opus") {
    return "opus";
  }
  return "audio";
}

function downloadTunnel(
  tunnelUrl,
  filePath,
  options,
  parentSignal,
  interruptAfterBytes
) {
  return withDeadline(
    parentSignal,
    options.downloadTimeoutMs,
    async (signal) => {
      const response = await fetch(tunnelUrl, { redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        await cancelResponse(response);
        throw new SmokeError("unexpected_redirect");
      }
      if (response.status !== 200) {
        await cancelResponse(response);
        throw new SmokeError(`tunnel_http_${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        await cancelResponse(response);
        throw new SmokeError("max_size_exceeded");
      }
      if (!response.body) {
        throw new SmokeError("empty_response");
      }

      let file;
      let reader;
      let bytes = 0;
      let completed = false;
      try {
        file = await open(filePath, "wx");
        reader = response.body.getReader();
        while (true) {
          // The stream must be consumed in order to enforce the byte limit.
          // eslint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          const { value } = chunk;
          if (bytes + value.byteLength > options.maxBytes) {
            throw new SmokeError("max_size_exceeded");
          }
          // The next chunk cannot be read until the current chunk is persisted.
          // eslint-disable-next-line no-await-in-loop
          await file.write(value);
          bytes += value.byteLength;
          if (interruptAfterBytes && bytes >= interruptAfterBytes) {
            throw new SmokeError("interrupted_transfer");
          }
        }
        if (bytes === 0) {
          throw new SmokeError("empty_response");
        }
        completed = true;
        return {
          bytes,
          contentType: response.headers.get("content-type") ?? "unknown",
        };
      } finally {
        const cleanup = [];
        if (reader) {
          cleanup.push(reader.cancel());
        }
        if (file) {
          cleanup.push(file.close());
        }
        await Promise.allSettled(cleanup);
        if (!completed) {
          await rm(filePath, { force: true });
        }
      }
    }
  );
}

function runCommand(command, args, signal, toolName) {
  // Spawn exposes events rather than a promise-based API.
  // eslint-disable-next-line promise/avoid-new
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    let killTimer;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      // The callback is either resolve or reject for the child event.
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      callback(value);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_JSON_BODY_BYTES) {
        stdout += chunk;
      }
    });
    // eslint-disable-next-line promise/prefer-await-to-callbacks
    child.once("error", (error) => {
      finish(
        reject,
        error.code === "ENOENT"
          ? new SmokeError(`${toolName}_unavailable`, { status: "blocked" })
          : new SmokeError(`${toolName}_failed`)
      );
    });
    child.once("close", (code) => finish(resolve, { code, stdout }));
  });
}

async function probeAudio(filePath, options, parentSignal) {
  const result = await withDeadline(
    parentSignal,
    options.probeTimeoutMs,
    (signal) =>
      runCommand(
        options.ffprobeBin,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,format_name:stream=codec_name,codec_type,duration",
          "-of",
          "json",
          filePath,
        ],
        signal,
        "ffprobe"
      )
  );
  if (result.code !== 0) {
    throw new SmokeError("ffprobe_failed");
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new SmokeError("ffprobe_invalid_output");
  }
  const audioStream = data.streams?.find(
    (stream) => stream?.codec_type === "audio"
  );
  const duration = Number(data.format?.duration ?? audioStream?.duration);
  if (!audioStream || !Number.isFinite(duration) || duration <= 0) {
    throw new SmokeError("audio_stream_invalid");
  }
  return {
    codec:
      typeof audioStream.codec_name === "string"
        ? audioStream.codec_name
        : "unknown",
    durationSeconds: duration,
    format:
      typeof data.format?.format_name === "string"
        ? data.format.format_name
        : "unknown",
  };
}

async function decodeAudio(filePath, options, parentSignal) {
  const result = await withDeadline(
    parentSignal,
    options.probeTimeoutMs,
    (signal) =>
      runCommand(
        options.ffmpegBin,
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          filePath,
          "-map",
          "0:a:0",
          "-f",
          "null",
          "-",
        ],
        signal,
        "ffmpeg"
      )
  );
  if (result.code !== 0) {
    throw new SmokeError("audio_decode_failed");
  }
}

async function runSample(
  sample,
  index,
  options,
  apiKey,
  parentSignal,
  tempDirectory
) {
  const startedAt = performance.now();
  const filePrefix = `${String(index + 1).padStart(2, "0")}-${sample.source}`;
  let filePath;
  try {
    const processing = await processRequest({
      apiKey,
      endpoint: options.endpoint,
      parentSignal,
      sourceUrl: sample.url,
      timeoutMs: options.processingTimeoutMs,
    });
    if (processing.kind !== "tunnel") {
      return {
        httpStatus: processing.httpStatus,
        identity: sample.identity,
        reason:
          processing.kind === "cobalt_error"
            ? processing.code
            : processing.reason,
        source: sample.source,
        status: "failed",
      };
    }
    filePath = path.join(tempDirectory, `${filePrefix}.${audioExtension()}`);
    const download = await downloadTunnel(
      processing.tunnelUrl,
      filePath,
      options,
      parentSignal
    );
    const probe = await probeAudio(filePath, options, parentSignal);
    await decodeAudio(filePath, options, parentSignal);
    const difference = Math.abs(
      probe.durationSeconds - sample.expectedDurationSeconds
    );
    if (difference > options.durationToleranceSeconds) {
      return {
        bytes: download.bytes,
        durationDifferenceSeconds: difference,
        expectedDurationSeconds: sample.expectedDurationSeconds,
        identity: sample.identity,
        observedDurationSeconds: probe.durationSeconds,
        reason: "duration_mismatch",
        source: sample.source,
        status: "failed",
      };
    }
    return {
      audioFormat: probe.format,
      bytes: download.bytes,
      codec: probe.codec,
      completedInMs: Math.round(performance.now() - startedAt),
      durationDifferenceSeconds: difference,
      expectedDurationSeconds: sample.expectedDurationSeconds,
      identity: sample.identity,
      observedContentType: download.contentType,
      observedDurationSeconds: probe.durationSeconds,
      source: sample.source,
      status: "passed",
    };
  } catch (error) {
    const result = resultFromError(error);
    return {
      identity: sample.identity,
      reason: result.reason,
      source: sample.source,
      status: result.status,
    };
  } finally {
    if (filePath) {
      await rm(filePath, { force: true });
    }
  }
}

async function runInterruption(
  sample,
  options,
  apiKey,
  parentSignal,
  tempDirectory
) {
  const filePath = path.join(tempDirectory, `interrupt-${sample.source}.audio`);
  try {
    const processing = await processRequest({
      apiKey,
      endpoint: options.endpoint,
      parentSignal,
      sourceUrl: sample.url,
      timeoutMs: options.processingTimeoutMs,
    });
    if (processing.kind !== "tunnel") {
      return resultFailed(
        processing.kind === "cobalt_error" ? processing.code : processing.reason
      );
    }
    try {
      await downloadTunnel(
        processing.tunnelUrl,
        filePath,
        options,
        parentSignal,
        options.interruptAfterBytes
      );
      return resultFailed("interruption_not_triggered");
    } catch (error) {
      if (
        !(error instanceof SmokeError) ||
        error.code !== "interrupted_transfer"
      ) {
        return resultFromError(error);
      }
      return resultPassed({ cancelledAfterBytes: options.interruptAfterBytes });
    }
  } catch (error) {
    return resultFromError(error);
  } finally {
    await rm(filePath, { force: true });
  }
}

function coverageResult(samples, source, predicate) {
  const matching = samples.filter(predicate);
  if (matching.length === 0) {
    return resultBlocked(`${source}_sample_missing`);
  }
  if (matching.some((sample) => sample.status === "passed")) {
    return resultPassed({ sampleCount: matching.length });
  }
  if (matching.some((sample) => sample.status === "blocked")) {
    return resultBlocked(`${source}_sample_blocked`);
  }
  return resultFailed(`${source}_sample_failed`);
}

function overallStatus(report) {
  const results = [
    ...Object.values(report.checks),
    ...report.samples,
    report.interruption,
    ...Object.values(report.coverage),
  ];
  if (results.some((result) => result?.status === "failed")) {
    return "failed";
  }
  if (results.some((result) => result?.status === "blocked")) {
    return "blocked";
  }
  return "passed";
}

export async function runSmoke(
  options,
  apiKey,
  parentSignal = new AbortController().signal
) {
  const temporaryParent = options.tempRoot ?? tmpdir();
  await mkdir(temporaryParent, { recursive: true });
  const tempDirectory = await mkdtemp(
    path.join(temporaryParent, "orbis-cobalt-trial-")
  );
  const report = {
    checks: {},
    coverage: {},
    deployment: {
      apiUrl: new URL(options.endpoint).origin,
      configuredDurationLimitSeconds: DURATION_LIMIT_SECONDS,
      image: COBALT_IMAGE,
      imageIndexDigest: COBALT_IMAGE_INDEX_DIGEST,
      imageVersion: COBALT_VERSION,
    },
    generatedAt: new Date().toISOString(),
    interruption: resultBlocked("not_run"),
    operatorHost: options.operatorHost,
    overall: "blocked",
    samples: [],
    schemaVersion: 1,
  };

  try {
    let instance;
    try {
      instance = await fetchInstanceInfo(options, parentSignal);
      report.deployment.observedVersion = instance.version ?? "unknown";
      report.checks.reachability = resultPassed();
    } catch (error) {
      report.checks.reachability = resultFromError(error);
    }

    report.checks.apiUrl = instance
      ? checkReportedApiUrl(instance.apiUrl, options.endpoint)
      : resultBlocked("instance_info_unavailable");
    report.checks.serviceScope = checkServices(instance?.services);
    if (instance?.services) {
      report.deployment.observedServices = instance.services;
    }

    const [firstSample] = options.samples;
    if (instance && firstSample) {
      report.checks.missingApiKey = await checkAuthorization(
        "missing_api_key",
        firstSample,
        null,
        options,
        parentSignal
      );
      report.checks.invalidApiKey = await checkAuthorization(
        "invalid_api_key",
        firstSample,
        INVALID_API_KEY,
        options,
        parentSignal
      );
      report.checks.invalidSource = await checkInvalidSource(
        firstSample,
        apiKey,
        options,
        parentSignal
      );

      for (let index = 0; index < options.samples.length; index += 1) {
        if (parentSignal.aborted) {
          break;
        }
        const sample = options.samples[index];
        report.samples.push(
          // Samples are intentionally processed in order to keep reports stable.
          // eslint-disable-next-line no-await-in-loop
          await runSample(
            sample,
            index,
            options,
            apiKey,
            parentSignal,
            tempDirectory
          )
        );
      }

      const longSample = options.samples.find(
        (sample) => sample.expectedDurationSeconds > 3 * 60 * 60
      );
      report.interruption = longSample
        ? await runInterruption(
            longSample,
            options,
            apiKey,
            parentSignal,
            tempDirectory
          )
        : resultBlocked("long_sample_missing");
    } else {
      report.checks.missingApiKey = resultBlocked("instance_unavailable");
      report.checks.invalidApiKey = resultBlocked("instance_unavailable");
      report.checks.invalidSource = resultBlocked("instance_unavailable");
      report.samples = options.samples.map((sample) => ({
        identity: sample.identity,
        reason: "instance_unavailable",
        source: sample.source,
        status: "blocked",
      }));
    }

    report.coverage.youtube = coverageResult(
      report.samples,
      "youtube",
      (sample) => sample.source === "youtube"
    );
    report.coverage.soundcloud = coverageResult(
      report.samples,
      "soundcloud",
      (sample) => sample.source === "soundcloud"
    );
    report.coverage.longSet = coverageResult(
      report.samples,
      "long_set",
      (_, index) =>
        options.samples[index]?.expectedDurationSeconds > 3 * 60 * 60
    );
    report.overall = overallStatus(report);
    return report;
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

export async function writeReport(report, reportPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath === "-") {
    process.stdout.write(serialized);
    return;
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serialized, { mode: 0o600 });
  await chmod(reportPath, 0o600);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof SmokeError) {
      console.error(`Usage error: ${error.message}`);
      console.error(usage());
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let apiKey;
  try {
    apiKey = await readApiKey(options);
  } catch (error) {
    if (error instanceof SmokeError) {
      console.error(`Usage error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const report = await runSmoke(options, apiKey, controller.signal);
    await writeReport(report, options.report);
    if (options.report === "-") {
      console.error(`Cobalt trial ${report.overall}.`);
    } else {
      console.log(`Cobalt trial ${report.overall}.`);
      console.log(`Report: ${options.report}`);
    }
    return report.overall === "passed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    process.exitCode = await main();
  } catch {
    process.exitCode = 2;
  }
}
