# Social is a symmetric master switch plus asymmetric per-person filters

Each Person has a Social master switch, off for a new Person. Off means they do not see anyone else's Library, Playlists, Presence, or Listen History, and nobody sees theirs. On unlocks social surfaces for that Person, subject to per-person filters.

For each other Person B, Person A holds two independent knobs (defaults on):

- **see B**: include B in A's social views
- **appear to B**: allow B to see A

A sees B's Library, Playlists, Presence, and Listen History only when all of these hold: both have Social on, A sees B, B appears to A, and the Host has not removed either. The server evaluates this in one module whose only operation resolves a Person the caller can see. That is the only way a route can reach another Person's data, so no route can forget the check. A request that fails the gate gets 404, not 403, so nobody can learn that someone has hidden them.

When the gate passes, A sees B's full Library and all of B's Playlists. Collaborative editing is separate (ADR 0010). Presence is the Set a Person is in a Listen on now, plus a short recent strip; full Listen History is on the profile.

The service does not record Listens today. It keeps `listenCount`, `finishCount`, and `lastListenedAt` on each Set, which cannot answer "what did B play on Tuesday." This decision adds a `listens` table: one row per Listen with Person, Set, start time, and finish time when it produced a Finish. The counters become derived values. Presence is the Person's active queue entry while their last Playback Position report is recent; a paused or abandoned player drops out of Presence. Presence changes reach viewers on the event stream (ADR 0014), filtered through the same gate.

Rejected alternatives:

- **One shared Library for all friends.** Library remains per Person.
- **Pure symmetric pairwise mute only.** The Host wants "they can see me, I do not want to see them right now."
- **Per-playlist share flags in v1.** Extra product surface; Social plus pairwise filters are enough.
- **Live presence only.** Recent and history are in scope, and the `listens` table serves both.
- **Social on by default.** Joining the Group would publish a Library before the Person has seen the switch.
