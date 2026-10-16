import path from "node:path";

import type { LoggingOptions } from "./logging.js";
import {
  describeCause,
  finishRequestLog,
  outcomeForStatus,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";
import type { StreamGrantVerdict } from "./stream-grant.js";
import { checkStreamGrant } from "./stream-grant.js";

const formats = [
  { contentType: "audio/mp4", extension: "m4a" },
  { contentType: "audio/mpeg", extension: "mp3" },
  { contentType: "audio/ogg", extension: "ogg" },
];

type AudioRange =
  | { readonly kind: "full" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const parseRange = (header: string | null, size: number): AudioRange => {
  if (!header) {
    return { kind: "full" };
  }
  const match = /^bytes=(?<first>\d*)-(?<last>\d*)$/u.exec(header.trim());
  if (!match?.groups) {
    return { kind: "unsatisfiable" };
  }
  const { first = "", last = "" } = match.groups;
  if (first === "" && last === "") {
    return { kind: "unsatisfiable" };
  }
  const start = first === "" ? Math.max(0, size - Number(last)) : Number(first);
  const end =
    first === "" || last === "" ? size - 1 : Math.min(size - 1, Number(last));
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  ) {
    return { kind: "unsatisfiable" };
  }
  return { end, kind: "range", start };
};

/** What one audio request's wide event records; the grant itself never appears. */
interface AudioRequestFields {
  readonly set?: string;
  readonly grant?: StreamGrantVerdict["kind"];
  readonly person?: string;
  readonly file?: "found" | "missing";
  readonly format?: string;
  readonly range?: string | undefined;
  readonly size?: number;
  /** The response body length. A client that disconnects early receives fewer. */
  readonly bytes?: number;
}

const MAX_RANGE_CHARACTERS = 64;

const serveAudio = async (
  request: Request,
  options: { readonly audioDir: string; readonly streamSecret: Buffer },
  record: (fields: AudioRequestFields) => void
): Promise<Response> => {
  const url = new URL(request.url);
  const match = /^\/(?:api\/)?sets\/(?<id>[a-zA-Z0-9_-]+)\/audio$/u.exec(
    url.pathname
  );
  const id = match?.groups?.id;
  if (!id) {
    return new Response(null, { status: 404 });
  }
  record({ set: id });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      headers: { allow: "GET, HEAD" },
      status: 405,
    });
  }
  const verdict = checkStreamGrant(
    options.streamSecret,
    id,
    url.searchParams.get("grant")
  );
  record({ grant: verdict.kind });
  if (verdict.kind !== "valid") {
    return Response.json({ message: "Invalid stream grant." }, { status: 401 });
  }
  record({ person: verdict.personId });
  const files = await Promise.all(
    formats.map(async (format) => {
      const file = Bun.file(
        path.join(options.audioDir, `${id}.${format.extension}`)
      );
      return (await file.exists()) ? { ...format, file } : null;
    })
  );
  const ready = files.find((file) => file !== null);
  if (!ready) {
    record({ file: "missing" });
    return Response.json(
      { message: "This Set has no audio yet." },
      { status: 404 }
    );
  }
  const { file } = ready;
  const rangeHeader = request.headers.get("range");
  record({
    file: "found",
    format: ready.extension,
    range: rangeHeader?.slice(0, MAX_RANGE_CHARACTERS),
    size: file.size,
  });
  const range = parseRange(rangeHeader, file.size);
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": ready.contentType,
  });
  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { headers, status: 416 });
  }
  const length =
    range.kind === "range" ? range.end - range.start + 1 : file.size;
  record({ bytes: request.method === "HEAD" ? 0 : length });
  headers.set("content-length", String(length));
  if (range.kind === "range") {
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${file.size}`
    );
    return new Response(
      request.method === "HEAD" ? null : file.slice(range.start, range.end + 1),
      { headers, status: 206 }
    );
  }
  return new Response(request.method === "HEAD" ? null : file, { headers });
};

/**
 * Serves granted audio from the node's disk and emits one wide event per request,
 * marked `ingress: "funnel-audio"`. The path is logged without its query string, so
 * the grant never reaches a line.
 */
export const makeNodeAudioHandler =
  (options: {
    readonly audioDir: string;
    readonly logging?: LoggingOptions | undefined;
    readonly streamSecret: Buffer;
  }): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const logger = startRequestLog({
      method: request.method,
      path: safeRequestPath(request.url),
      requestId: crypto.randomUUID(),
    });
    logger.set({ ingress: "funnel-audio" });
    try {
      const response = await serveAudio(request, options, (fields) =>
        logger.set({ audio: fields })
      );
      finishRequestLog(
        logger,
        { outcome: outcomeForStatus(response.status), status: response.status },
        options.logging
      );
      return response;
    } catch (error) {
      logger.set({ cause: describeCause(error) });
      finishRequestLog(
        logger,
        { outcome: "failure", status: 500 },
        options.logging
      );
      throw error;
    }
  };
