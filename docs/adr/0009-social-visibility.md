# Social is a symmetric master switch plus asymmetric per-person filters

Each Person has a Social master toggle. Off means they do not see anyone else's library, playlists, presence, or history, and nobody sees theirs. On unlocks social surfaces for that Person, subject to per-person filters.

For each other Person B, Person A holds two independent knobs (defaults on):

- **see B** — include B in A's social views
- **appear to B** — allow B to see A when B's social is on and B sees A

So A can stay visible to B while filtering B out of A's own feed. A sees B's library, playlists, presence, and history only when all of: both have Social on, A sees B, B appears to A, and neither has been removed by the host.

When Social is on and the pairwise gates pass, friends see the full library and all playlists (collaborative editing is separate). Presence is live Listen plus a recent strip; full Listen/Finish history is on the profile. The server keeps listen data so the UI can change later without a new capture pipeline.

Rejected alternatives:

- **One shared library for all friends.** Rejected; Library remains per Person (CONTEXT.md).
- **Pure symmetric pairwise mute only.** Rejected; the host wants "they can see me, I do not want to see them right now."
- **Per-playlist share flags in v1.** Extra product surface; Social + pairwise filters are enough.
- **Live presence only.** Rejected; recent and history are in scope because the data already exists as Listens.
