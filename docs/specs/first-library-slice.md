# Orbis: first library slice

This records the implementation scope selected in the conversation, not the full product specification.

## Requirements

1. Rename the scaffold and workspace packages from Sets to Orbis.
2. Keep Electron + React for desktop; use Bun, Effect v4 RC, and TypeScript 7 for the application stack. Preserve the Effect tooling setup.
3. Save direct YouTube video and SoundCloud track links with a user-entered title and multiple tags.
4. Store the library in SQLite and retain it after server restarts.
5. Normalize source links so tracking parameters and equivalent YouTube URLs do not create duplicates. Reject unsupported or malformed links; report duplicates without overwriting existing data.
6. Normalize tags, suggest existing tags, and allow users to add, remove, or clear tags after saving.
7. Combine text search, source filtering, and all selected tags. Distinguish an empty library from no matching results.
8. Show loading, save confirmation, validation errors, and server-unavailable states; allow retry without losing an unsaved form.
9. Keep this slice local-only with no app login. The desktop main process calls the server; renderer code has no Node access or arbitrary HTTP bridge. Reject browser-origin and non-loopback-host requests to the library API.
10. Provide accessible labeled controls and keyboard-operable saving and filtering.

11. Create ordered playlists of whole sets; allow adding existing sets, reordering, and removing membership without deleting library entries. A set can belong to multiple playlists. Folders and disk hierarchy were explicitly deferred.
12. Apply the user-selected shadcn preset `b1VlIttI` to the desktop UI.

## Playlist membership capacity

A Playlist holds at most 500 Sets, and a Set belongs to at most 100 Playlists. These are separate limits for separate relationships, not one shared size.

Both membership routes state a whole membership: `PUT /playlists/:id/sets` states which Sets a Playlist holds, and `PUT /sets/:id/playlists` states which Playlists a Set belongs to. Each request is validated and applied inside one transaction, so a request that would push past a limit returns 400 and changes nothing. A membership that already exists at a limit is kept, which leaves reordering and unchanged resubmission valid.

The limits govern new membership only. Data saved before the limits were enforced stays readable and is never trimmed or deleted automatically; an over-limit Playlist or Set shrinks through a valid-size full-list request or through removals in the opposite direction.

## Agreed testing boundaries

- HTTP request/response boundary for persistence, URL validation, duplicate handling, tags, and combined filters. Use real temporary SQLite databases, not mocked storage internals.
- A desktop smoke check for saving, filtering, tag editing, and reloading through the real Electron preload/main process and server API.
- Run typechecking regularly and the complete suite at the end; independently review standards and requirements before the implementation commit.

## Scope boundary

Downloads, retention rules, embedded playback, groups, Tailscale identity, remote server configuration, iOS, working Raycast commands, Versos integration, and MCP are later slices. Opening a saved source in the browser is available; this is not in-app playback.

Source metadata fetching, SoundCloud short-link resolution, private SoundCloud links, bulk import, deletion, and title editing are not implemented in this slice. The local directory name can remain `setsapp`; product and workspace names use Orbis.
