import type { SavedSet } from "@orbis/contracts";

import { LibraryError } from "./errors.js";

const invalid = () =>
  new LibraryError({
    message: "Use a direct YouTube video or SoundCloud track URL.",
    statusCode: 400,
  });

export const normalizeSourceUrl = (
  value: string
): Pick<SavedSet, "url" | "source"> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw invalid();
  }
  const host = url.hostname;
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(host)
  ) {
    let id: string | null = null;
    if (host === "youtu.be") {
      id = url.pathname.slice(1);
    } else if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      id =
        /^\/(?:shorts|live|embed)\/(?<id>[\w-]{11})\/?$/u.exec(url.pathname)
          ?.groups?.id ?? null;
    }
    if (!id || !/^[\w-]{11}$/u.test(id)) {
      throw invalid();
    }
    return { source: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (
    ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host)
  ) {
    const match = /^\/(?<artist>[\w-]+)\/(?<track>[\w-]+)\/?$/u.exec(
      url.pathname
    )?.groups;
    if (
      !match?.artist ||
      !match.track ||
      ["sets", "tracks", "albums", "likes", "reposts"].includes(match.track)
    ) {
      throw invalid();
    }
    return {
      source: "soundcloud",
      url: `https://soundcloud.com/${match.artist}/${match.track}`,
    };
  }
  throw invalid();
};
