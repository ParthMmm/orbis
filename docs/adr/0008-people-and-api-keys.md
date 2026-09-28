# People in one private group authenticate with API keys

The deployment is one private Group: everyone the Host admits. A Person has a stable id, a username they set and may change, and one or more API keys. Every request on the device listener resolves its key to exactly one Person, and every route acts as that Person. Routes name other People by id, so a rename breaks no link.

The Host is a Person with extra powers: mint and revoke keys, and remove People (cascading their Library Entries, owned Playlists, editor grants, queue, and Listens). The Host uses them from an admin page in the web client, backed by `/admin` routes. Those routes accept only a key with the `admin` scope, which only the Host can hold. The Host keeps that key in a password manager rather than on a daily device, and the admin page holds it in `sessionStorage` only, so it is gone when the tab closes. A stolen daily key, including the Host's, cannot reach `/admin`. `bun run trust` on Vanta keeps the same powers, for the first admin key and for recovery when no admin key is left. Day-to-day library edits stay with each Person.

Each key records when it was last used, updated at most once an hour, so the admin page can show keys nobody uses.

Keys follow the ADR 0004 digest pattern: printed once, host stores `sha256` only, revoke by deleting the record. The trust store gains a `people` list and each key record gains a `personId` and a `scope`. The migration makes the existing owner the Host Person and assigns every existing device record to them, so paired devices keep working without re-pairing. The same key family works on web, native Apple clients, and Raycast. Requests on the token-free local listener (`4310`) act as the Host Person.

Key delivery is out of band. Orbis does not send iMessage, email, or SMS. The Host copies the one-time plaintext key and sends it through a channel they already trust with that friend. The client asks for the key once and stores it: the Keychain on Apple platforms, `localStorage` on the web. Browser storage is readable by any script on the origin, so the SPA ships a strict Content Security Policy and no third-party scripts. Keys never go in URL query strings (history, proxies, analytics); ADR 0007 covers audio. One-time claim links are deferred.

This evolves ADR 0004's device principal into a Person principal. Device labels remain as key labels under a Person.

Rejected alternatives:

- **Public signup.** Out of scope for a private group.
- **Per-client key types (web vs device).** Extra ceremony for no isolation gain when revoke already kills all of a person's clients.
- **Orbis-mediated delivery (email or iMessage from the server).** Expands the trust surface and is unnecessary when the Host already has a channel to the friend.
- **Host powers on the Host's daily key.** One leaked phone or browser would give full control from the internet.
- **Host powers on Vanta's command line only.** Safe, and needs an SSH session to invite a friend.
