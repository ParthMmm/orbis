# Sign in by Invite and Device Link, and keep one API key per device

A Person's data already follows them across devices: every request acts as a Person (ADR 0008), so each of their devices reads and changes the same Library, Playlists, Listening Queue, and Playback Positions. What does not scale is getting a key onto each device. The Host mints a key, copies it, and sends it, once per device, and the Apple TV has no good way to paste one. Orbis gains two ways for a device to obtain its own key. The credential stays the same: one labeled, revocable API key per device.

An **Invite** signs in a Person's first device. The Host creates one from the admin page for a new or an existing Person and sends the link through a channel they already trust, as ADR 0008 does for keys. The link is `https://orbis.p11a.xyz/claim#<code>`. The code sits in the fragment, so neither Cloudflare nor any log sees it; the web client reads it and sends it to the API. The API stores only the code's `sha256`, accepts it once, and lets it expire after 24 hours. A valid claim mints a daily key for that Person, labeled with the browser the friend names, and returns it once; the web client stores it as it stores a pasted key today. An Invite for an existing Person is how a friend who lost every device gets back in, with their Library intact. Invites live in the trust store with the keys, so a restart does not cancel them.

A **Device Link** signs in every device after the first. The new device asks the API to start a link and shows a short code, eight characters from an alphabet without look-alikes, plus a QR code for `https://orbis.p11a.xyz/link#<code>`. On a device that is already signed in, the Person opens "Add a device", scans or types the code, sees the new device's label, and approves. The new device polls with a separate secret it received when it started, and gets its key once, after approval. A link expires after 10 minutes and exists only in memory, so a restart cancels pending links and the device starts again. This is the OAuth device authorization flow (RFC 8628) with Orbis keys in place of tokens. It works the same on the web, macOS, iOS, and tvOS.

Neither path can produce an admin key. Invites and Device Links mint only daily keys, so the admin scope stays with `bun run trust` and the Host's password manager (ADR 0008).

A Person can list and revoke their own keys from a Devices page, so a lost phone does not need the Host. The Host keeps the power to revoke any key.

The routes that redeem a code (claim an Invite, poll a Device Link) accept requests without a key, so they count toward the per-client limit on failed key attempts and answer 429 in the same way. Approving a Device Link needs a signed-in Person. The routes are additions to the typed contract (ADR 0014) on the current API on Vanta, and they move with the API when it moves to Workers and D1 (ADR 0015).

The native clients carry the API address the way the web client does (ADR 0015), so the Apple apps ask for nothing but a Device Link code or, until they support it, a key.

Rejected alternatives:

- **An auth provider with sessions (Better Auth, Clerk, Sign in with Apple).** Adds a session cookie beside the keys, the second credential kind ADR 0007 rejected, and a sign-up system for a Group of a few people the Host admits by hand.
- **Passkeys now.** The smoothest sign-in and synced by iCloud Keychain, but it needs WebAuthn on the server and associated domains in every Apple app. Invites and Device Links remove the same friction with less work. Passkeys can later become a third way to obtain a key.
- **The key itself in the link's fragment.** One step fewer than an Invite, but the key would live on in chat and browser history, and ADR 0008 keeps keys out of URLs. A spent or expired Invite code in history is harmless.
- **Email or SMS magic links.** Orbis does not send messages (ADR 0008).
- **Pending Device Links in the database.** They live for 10 minutes; losing them in a restart costs one retry.

The trade this accepts is the device flow's known phishing risk: someone who starts a Device Link can send its code to a Person and ask them to approve it. The approval screen names the new device and says to approve only a device in front of you, and for a small private Group that warning is the defense. Invites also give whoever holds the link one day to use it, so the Host sends them only through a trusted channel.
