# Retained Audio is shared by Source Link; collaborative Playlists are opt-in

A Set is canonical on the box by Source Link. Retained Audio and Download jobs attach to that canonical Set: one retained file per Source Link on Vanta. Anyone who can see the Set may enqueue a Download if Retained Audio is missing. Playing a visible Set streams that shared file; the listener does not need to add it to their own Library. ADR 0013 splits what belongs to the Set from what belongs to each Person.

Retained Audio is deleted when nothing refers to its Set: no Library Entry, no Playlist, and no Listening Queue. A Person removing a Set from their Library never deletes audio someone else still uses. The audio storage module owns this rule behind one "release this Set" operation, so remove paths do not count references themselves.

The download worker stays sequential (ADR 0002), so one Person saving fifty Sets would make everyone else wait behind them. The worker takes the next job round-robin across the People who queued jobs, and each Person may have at most 20 jobs waiting. A job records who asked for it only for scheduling; the Retained Audio still belongs to the Set.

Playlists stay owned by a creator. By default only the creator edits. A Collaborative flag lets the creator add editors who may add, remove, and reorder Sets. Only the creator renames, toggles Collaborative, deletes the Playlist, or manages editors. The creator may only add an editor who passes the ADR 0009 gate with them, and an editor's rights lapse while that gate is closed. Sets added to a Playlist must already be visible to the editor; adding does not save the Set into anyone's Library.

Rejected alternatives:

- **Per-person Retained Audio copies.** Wastes disk and Cobalt work; fights "stream without adding to my library."
- **Only the Set saver may download.** Leaves "I can see it but cannot play it" holes when audio is missing.
- **Editors may rename, delete, or toggle Collaborative.** Keeps ownership muddy; the creator owns the Playlist object.
- **First come, first served downloads.** Fair for one person, and lets one friend's import block the Group for hours.
- **Delete audio when the saver removes the Set.** Breaks other People's Libraries and Playlists without warning.
