# API

The server is a Bun and Effect HTTP API. Routes are wired in `apps/server/src/app.ts`; this table lists the main ones and is not exhaustive.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Health status |
| POST | `/sets` | Save `{ url }`. `title` and `tags` are optional. A missing `tags` is an empty list. |
| GET | `/sets` | List newest first; optional `q`, `source`, `playlistId`, repeated `tag` parameters |
| PATCH | `/sets/:id/title` | Replace title with `{ title }` |
| PATCH | `/sets/:id/tags` | Replace tags with `{ tags }` |
| DELETE | `/sets/:id` | Delete a Set and related membership |
| GET | `/tags` | Existing tags for suggestions |
| GET / POST | `/playlists` | List playlists or create one with `{ name }` |
| PUT | `/playlists/:id/sets` | Replace ordered membership with `{ setIds }` |
| GET | `/queue` | The one Listening Queue in play order, with its active Set |
| PUT | `/queue/active` | Make `{ setId }` the active Set |
| POST | `/queue/entries` | Queue `{ setId, placement }`, where placement is `next` or `end` |
| PUT | `/queue/playlist` | Replace the queue with a Playlist's playable members, in Playlist order |
| POST | `/queue/completion` | Finish `{ setId }`: remove it, reset its position, start what followed |
| PUT | `/sets/:id/position` | Report `{ seconds }` of Playback Position |
| POST / DELETE | `/sets/:id/audio/download` | Start or cancel a Download of the Set's Retained Audio |
| GET | `/sets/:id/audio/state` | Download state and byte progress |
| GET | `/sets/:id/audio` | Stream Retained Audio with byte-range support |

Tags are trimmed, lowercased, and deduplicated; each set accepts up to 20 tags of 40 characters. Tag filters use AND semantics. Text search checks titles and URLs. Duplicate normalized links return 409; invalid input returns 400. Metadata is entered manually; short SoundCloud share links and private track links are not supported yet.

Playlists contain whole sets, not individual tracks. A set can belong to multiple playlists; removing membership keeps the library entry. Each playlist supports up to 500 unique sets. Library views sort newest first; playlist views keep playlist order. Folders are deferred.

The Listening Queue is one ordered list with at most one active Set, and the active Set is the one whose Listen is open. Tapping a playable Set makes it active and keeps the rest of the queue; `next` inserts after the active Set and `end` appends; playing a Playlist replaces the queue with its playable members in Playlist order. Only Sets with Retained Audio can be queued. When the active Set finishes, it leaves the queue, its Playback Position returns to zero, and the Set that followed it becomes active; an empty queue stops. A Listen is counted when a Set becomes active and at most one Finish per Listen, so a signal repeated by another device counts nothing. A Playback Position is stored as whole seconds, never below zero and never past the Set's own length.

The desktop uses shadcn preset `b1VlIttI`, Tailwind v4, and the Inter variable font. Layout styles are separate from the generated theme tokens.

Design tokens live in `docs/design/tokens.json`. `node scripts/design-tokens.mjs` regenerates the Swift colors in `OrbisDesign` and `docs/design/tokens.css`.
