import path from "node:path";

import type { Layer } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { createPortableApp } from "./app-core.js";
import { releaseAudio } from "./audio-release.js";
import { Audio } from "./audio.js";
import type { AudioFile, AudioOptions } from "./audio.js";
import type { Database } from "./db/database.js";
import { layer as databaseLayer } from "./db/database.js";
import { migrateTrustStore } from "./identity.js";
import type { LoggingOptions } from "./logging.js";
import { MediaStore } from "./media-store.js";
import type { Metadata } from "./metadata.js";
import type { PresenceJournal } from "./presence-journal.js";
import type { PresenceOptions } from "./presence.js";
import { grantSecret } from "./stream-grant.js";
import type { TitleReviser } from "./title-reviser.js";
import { useNonblockingTrustStorage } from "./trust-storage-bun.js";
import type { Versos } from "./versos.js";

type AudioRange =
  | { readonly offset: number; readonly length: number }
  | { readonly unsatisfiable: true };

// AVPlayer seeks with byte ranges on every read, so the range grammar is parsed here
// and an unsatisfiable range is a 416, not a silent full response.
const audioRange = (
  header: string | null | undefined,
  size: number
): AudioRange | null => {
  if (!header) {
    return null;
  }
  const match = /^bytes=(?<first>[0-9]*)-(?<last>[0-9]*)$/u.exec(header.trim());
  if (!match?.groups) {
    return null;
  }
  const { first = "", last = "" } = match.groups;
  if (first === "" && last === "") {
    return null;
  }
  let start = first === "" ? size - Number(last) : Number(first);
  const end = last === "" ? size - 1 : Number(last);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < 0) {
    return null;
  }
  start = Math.max(start, 0);
  if (start >= size) {
    return { unsatisfiable: true };
  }
  return { length: Math.min(end, size - 1) - start + 1, offset: start };
};

const audioFileResponse = (file: AudioFile, range: AudioRange | null) => {
  const headers = {
    "accept-ranges": "bytes",
    "content-type": file.contentType,
  };
  if (!range) {
    return HttpServerResponse.raw(Bun.file(file.path), { headers });
  }
  if ("unsatisfiable" in range) {
    return HttpServerResponse.empty({
      headers: { "content-range": `bytes */${file.bytes}` },
      status: 416,
    });
  }
  return HttpServerResponse.raw(
    Bun.file(file.path).slice(range.offset, range.offset + range.length),
    {
      contentLength: range.length,
      headers: {
        ...headers,
        "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${file.bytes}`,
      },
      status: 206,
    }
  );
};

export const createApp = (
  options: {
    audio?: AudioOptions;
    databasePath?: string;
    database?: Layer.Layer<Database, unknown>;
    devicesPath?: string;
    logging?: LoggingOptions;
    recordKeyUse?: boolean;
    metadata?: Layer.Layer<Metadata>;
    /** How long after a Playback Position report a Person still counts as listening. */
    presenceWindowMs?: number;
    presence?: PresenceOptions & { journal?: Layer.Layer<PresenceJournal> };
    /** How long a Device Link stays open. Tests shorten it to prove expiry. */
    deviceLinkTtlMs?: number;
    deviceLinkNow?: () => number;
    /** How long an Invite stays claimable. Tests shorten it to prove expiry. */
    inviteTtlMs?: number;
    /** Follows short links such as `on.soundcloud.com`. Tests pass a stub to stay offline. */
    shortLinkFetch?: (url: string, signal: AbortSignal) => Promise<Response>;
    titleReviser?: Layer.Layer<TitleReviser>;
    versos?: Layer.Layer<Versos>;
  } = {}
) => {
  useNonblockingTrustStorage();
  const databasePath = options.databasePath ?? ":memory:";
  const devicesPath =
    options.devicesPath ??
    (databasePath === ":memory:"
      ? undefined
      : path.join(path.dirname(databasePath), "devices.json"));
  const trustPath = databasePath === ":memory:" ? devicesPath : databasePath;
  if (devicesPath) {
    migrateTrustStore(
      devicesPath,
      databasePath === ":memory:" ? devicesPath : databasePath
    );
  }
  return createPortableApp({
    ...options,
    audio: Audio.layer({ ...options.audio, logging: options.logging }),
    audioResponse: (file, range) =>
      audioFileResponse(file, audioRange(range, file.bytes)),
    database:
      options.database ??
      databaseLayer({
        databasePath,
        migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
      }),
    releaseAudio: (id) =>
      releaseAudio(id, () => MediaStore.removeFiles(id, options.audio)),
    streamSecret: grantSecret(
      databasePath === ":memory:"
        ? undefined
        : path.join(path.dirname(databasePath), "stream-grant.key")
    ),
    trustPath,
  });
};
