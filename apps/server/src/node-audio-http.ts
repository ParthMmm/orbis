import path from "node:path";

import { verifyStreamGrant } from "./stream-grant.js";

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

export const makeNodeAudioHandler =
  (options: {
    readonly audioDir: string;
    readonly streamSecret: Buffer;
  }): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const url = new URL(request.url);
    const match = /^\/(?:api\/)?sets\/(?<id>[a-zA-Z0-9_-]+)\/audio$/u.exec(
      url.pathname
    );
    const id = match?.groups?.id;
    if (!id) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        headers: { allow: "GET, HEAD" },
        status: 405,
      });
    }
    const grant = url.searchParams.get("grant");
    if (!grant || !verifyStreamGrant(options.streamSecret, id, grant)) {
      return Response.json(
        { message: "Invalid stream grant." },
        { status: 401 }
      );
    }
    const files = await Promise.all(
      formats.map(async (format) => {
        const file = Bun.file(
          path.join(options.audioDir, `${id}.${format.extension}`)
        );
        return (await file.exists())
          ? { contentType: format.contentType, file }
          : null;
      })
    );
    const ready = files.find((file) => file !== null);
    if (!ready) {
      return Response.json(
        { message: "This Set has no audio yet." },
        { status: 404 }
      );
    }
    const { file } = ready;
    const range = parseRange(request.headers.get("range"), file.size);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "content-type": ready.contentType,
    });
    if (range.kind === "unsatisfiable") {
      headers.set("content-range", `bytes */${file.size}`);
      return new Response(null, { headers, status: 416 });
    }
    if (range.kind === "range") {
      headers.set(
        "content-range",
        `bytes ${range.start}-${range.end}/${file.size}`
      );
      headers.set("content-length", String(range.end - range.start + 1));
      return new Response(
        request.method === "HEAD"
          ? null
          : file.slice(range.start, range.end + 1),
        {
          headers,
          status: 206,
        }
      );
    }
    headers.set("content-length", String(file.size));
    return new Response(request.method === "HEAD" ? null : file, { headers });
  };
