# People in one private group authenticate with API keys

The deployment is one private Group: everyone the Host admits. A Person has a username they set and one or more API keys. Every request on the device listener resolves its key to exactly one Person, and every route acts as that Person.

The Host is a Person with extra powers: mint and revoke keys, and remove People (cascading their Library Entries, owned Playlists, editor grants, queue, and Listens). These powers stay on Vanta as `bun run trust` commands in v1. No admin route exists on the API, so a stolen key can never mint another. Day-to-day library edits stay with each Person.

Keys follow the ADR 0004 digest pattern: printed once, host stores `sha256` only, revoke by deleting the record. The trust store gains a `people` list and each key record gains a `personId`. The migration makes the existing owner the Host Person and assigns every existing device record to them, so paired devices keep working without re-pairing. The same key family works on web, native Apple clients, and Raycast. Requests on the token-free local listener (`4310`) act as the Host Person.

Key delivery is out of band. Orbis does not send iMessage, email, or SMS. The Host copies the one-time plaintext key and sends it through a channel they already trust with that friend. The client asks for the key once and stores it: the Keychain on Apple platforms, `localStorage` on the web. Browser storage is readable by any script on the origin, so the SPA ships a strict Content Security Policy and no third-party scripts. Keys never go in URL query strings (history, proxies, analytics); ADR 0007 covers audio. One-time claim links are deferred.

This evolves ADR 0004's device principal into a Person principal. Device labels remain as key labels under a Person.

Rejected alternatives:

- **Public signup.** Out of scope for a private group.
- **Per-client key types (web vs device).** Extra ceremony for no isolation gain when revoke already kills all of a person's clients.
- **Orbis-mediated delivery (email or iMessage from the server).** Expands the trust surface and is unnecessary when the Host already has a channel to the friend.
- **Admin routes on the API.** Lets the web client manage people, and turns one leaked Host key into full control from the internet.
