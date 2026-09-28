# People in one private group authenticate with API keys

The deployment is one private group: everyone the host admits. The host is god — mint and revoke keys, remove people (cascade their membership, owned playlists, presence). Day-to-day library edits stay with each person; removal is the kill switch.

A Person has a username they set and one or more API keys. Keys follow the ADR 0004 digest pattern: printed once, host stores `sha256` only, revoke by deleting the record. The same key family works on web, Electron (when not on local 4310), and Apple clients against the device listener / `api.orbis.p11a.xyz`. Local `4310` remains the token-free Electron loopback path.

Key delivery is out of band. Orbis does not send iMessage, email, or SMS. The host copies the one-time plaintext key and sends it through a channel they already trust with that friend (iMessage is fine for known people). A shared password-manager item is a better place for the friend to *keep* the key after paste. The web/native client asks them to paste the key once and store it locally. Do not put keys in URL query strings (history, proxies, analytics). One-time claim links are deferred.

This evolves ADR 0004's device principal into a Person principal for shared access. Device-shaped labels may remain as key labels under a Person.

Rejected alternatives:

- **Public signup.** Out of scope for a private group.
- **Per-client key types (web vs device).** Extra ceremony for no isolation win when revoke already kills all of a person's clients.
- **Orbis-mediated delivery (email/iMessage from the server).** Expands the trust surface and is unnecessary when the host already has a channel to the friend.
