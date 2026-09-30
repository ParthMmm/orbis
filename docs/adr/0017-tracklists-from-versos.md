# Read one Tracklist per Set from Versos

A Set has one Tracklist shared by everyone who can see it, as Artwork is shared. Orbis asks Versos for that Tracklist after source details are read because Versos needs the source description. This work runs after the save response, and a failed request leaves the Set saved and offers a retry. Existing Sets can be filled by a backfill.

Orbis uses one server key for Versos rather than a key for each Person. Versos owns identification of Cues and their start times; Orbis stores the result and serves it through the Set's visibility rules. A Cue without a start time remains visible, but it has no seek action. Orbis does not create a Versos or Apple Music playlist. iOS, macOS, and web show the Tracklist; CarPlay does not yet.

The Versos API work is tracked by PAL-771. Until it ships, Orbis uses a fake Versos service in tests and leaves the live provider unconfigured by default.
