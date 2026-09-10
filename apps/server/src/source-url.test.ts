import { expect, test } from "bun:test";

import { LibraryError } from "./errors.js";
import { normalizeSourceUrl } from "./source-url.js";

test("normalizes supported source URL forms without widening the allowlist", () => {
  for (const url of [
    "http://youtu.be/abcdefghijk?t=30",
    "https://www.youtube.com/watch?v=abcdefghijk&list=ignored",
    "https://m.youtube.com/shorts/abcdefghijk/",
    "https://music.youtube.com/live/abcdefghijk",
    "https://youtube.com/embed/abcdefghijk/",
  ]) {
    expect(normalizeSourceUrl(url)).toEqual({
      source: "youtube",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
  }
  expect(
    normalizeSourceUrl("http://m.soundcloud.com/artist/track/?ref=share")
  ).toEqual({
    source: "soundcloud",
    url: "https://soundcloud.com/artist/track",
  });
});

test("rejects credentials, ports, unsupported paths, hosts, and protocols", () => {
  for (const url of [
    "not a URL",
    ["javascript", "alert(1)"].join(":"),
    "https://user:password@www.youtube.com/watch?v=abcdefghijk",
    "https://soundcloud.com:8080/artist/track",
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk/extra",
    "https://youtube.com/shorts/abcdefghij",
    "https://youtube.com/embed/abcdefghijk/extra",
    "https://soundcloud.com/artist/track/extra",
    "https://soundcloud.com/artist/sets",
    "https://soundcloud.com/artist/tracks",
    "https://soundcloud.com/artist/albums",
    "https://soundcloud.com/artist/likes",
    "https://soundcloud.com/artist/reposts",
  ]) {
    expect(() => normalizeSourceUrl(url)).toThrow(LibraryError);
  }
});
