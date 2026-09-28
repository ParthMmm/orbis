# Split the Set into shared facts and per-Person state before a second Person joins

The `sets` table holds one row per Source Link, and that row mixes two kinds of fact. Some belong to the recording: the Source Link, provider metadata, Artwork, Retained Audio, and download state. Others belong to whoever saved it: the edited title, Tags, Playback Position, and the Listen counters. The Listening Queue, Playlists, and title edits have no owner at all, because one person was the only reader. ADR 0010 makes the Set canonical across People, so the second kind must move before a second Person can save anything.

The shared **Set** keeps the Source Link, source, provider title, creator, duration, both Artwork addresses, metadata state, and Retained Audio and download state.

A **Library Entry** is one Person's saving of one Set: Person, Set, saved time, a title override, and Tags. ADR 0005's rule survives with a narrower scope: enrichment writes the Set's provider title, and a Person's edit writes only their Library Entry's override. A Person who has not edited sees the provider title, so a retry that improves it reaches every Library at once.

Per-Person tables replace the owner-less ones: Playback Position is keyed by Person and Set, the Listening Queue by Person, and Listens (ADR 0009) by Person. Playlists gain a creator. A Person can hold Playback Position, queue entries, and Listens for a Set outside their Library, because ADR 0010 lets them play a visible Set without saving it.

The migration creates the Host Person and assigns every existing row to them: one Library Entry per Set, carrying the current title as an override where `title_edited_by_user` is set. It must run and ship before the first friend key is minted.

API routes keep their shapes and gain an implied Person. `GET /sets` returns the caller's Library Entries joined to their Sets. Reading another Person's Library is `GET /people/:username/sets`, behind the ADR 0009 gate. Writes to a Set's shared facts, such as a metadata retry or a Download, need only visibility; writes to per-Person state need ownership.

Rejected alternatives:

- **Add a `person_id` column to `sets`.** Duplicates the Set per Person, which breaks one Retained Audio per Source Link.
- **Keep one shared title and let any saver edit it.** One friend's rename would change every other Library.
- **Keep one shared queue and Playback Position.** Two People listening at once would fight over the active Set.
- **Admit friends first and split later.** Every friend's writes before the split land in state the migration cannot attribute.

The trade this accepts is a join on every Library read and a migration that touches every table. SQLite handles the join at this scale, and the migration runs once against one owner's data.
