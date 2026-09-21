import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { libraryEmptyCopy } from "./library-empty-copy.ts";

describe("libraryEmptyCopy", () => {
  it("describes an empty library when nothing filters the list", () => {
    assert.deepEqual(libraryEmptyCopy({ filtering: false, playlistId: null }), {
      message: "Save your first YouTube or SoundCloud set using the form.",
      title: "Start your collection",
    });
  });

  it("describes no matching results when filters are active", () => {
    assert.deepEqual(libraryEmptyCopy({ filtering: true, playlistId: null }), {
      message: "Try another search or clear your filters.",
      title: "No matching sets",
    });
  });

  it("keeps the no-match copy when a playlist is also selected", () => {
    assert.deepEqual(
      libraryEmptyCopy({ filtering: true, playlistId: "playlist-1" }),
      {
        message: "Try another search or clear your filters.",
        title: "No matching sets",
      }
    );
  });

  it("describes an empty playlist when the library still has sets", () => {
    assert.deepEqual(
      libraryEmptyCopy({ filtering: false, playlistId: "playlist-1" }),
      {
        message: "Add saved sets using Manage playlist.",
        title: "This playlist is empty",
      }
    );
  });
});
