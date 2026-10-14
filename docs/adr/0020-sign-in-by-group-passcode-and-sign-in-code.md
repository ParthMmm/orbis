# Sign in with a Group Passcode or a Sign-in Code

This replaces ADR 0016 and the recovery sections of ADRs 0008 and 0018.

Orbis serves the Host and a few friends. The Host found Invites, Device Links, QR codes, Cloudflare Access recovery, a separate admin key, and an editable service address too hard to use. On 2026-10-10 a fresh iPhone could not sign in. Every way in needed a device that was already signed in, and the only way to mint a first key ran through Access. The Host accepts that a leaked key is a small loss for this Group. That allows a simpler model with two ways in and one credential.

**Group Passcode.** A new Person joins without the Host. They choose a username and type the Group Passcode, which the Host tells friends in person or in a chat. The API creates the Person and a daily key for that device in one step. The Host sets, shows, changes, and clears the passcode in Settings. While no passcode is set, joining is closed. The passcode is stored as plain text so the Host can read it back. It grants only what any Person has. Changing it does not affect anyone who already joined.

**Sign-in Code.** A Person adds a device from one they already use. Settings on the signed-in device shows an eight-character code from an alphabet without look-alikes. The new device asks for that code and receives its own daily key. A code works once and expires after 10 minutes. Each Person has at most one live code, and issuing a new one replaces it. Codes live in the trust store, so a restart does not cancel them. The Host can also show a Sign-in Code for any Person, which is how a friend who lost every device gets back in with their Library intact. Recovery uses the same path. `bun run trust recover` on Vanta calls `/api/recovery` with Vanta's node key and prints a Sign-in Code for the Host. The node key can already export all Group data, so it gains no new power.

**One kind of Person key.** Host powers belong to the Host Person, not to a key scope. Any key that belongs to the Host can open People and the admin routes. Stored `admin` keys become `daily` keys when the Group upgrades, so they keep working with the same token, and new keys are always `daily`. Every device holds one daily key, labeled with the device's name, and appears on the Person's Devices list. The `node` scope is unchanged.

**One address.** The Apple apps call `https://orbis.p11a.xyz/api` and have no address field. Debug builds keep the launch argument that points a journey at its lane's service.

The redeem and join routes accept requests without a key. They count toward the per-client limit on failed key attempts and answer 429 in the same way, which limits guessing a passcode or a code. An attempt is counted when it starts, an IPv6 client is counted by its /64 block, and one Group-wide limit of 100 failed sign-in attempts, which clears a minute after the last one, covers guesses spread over many addresses. A passcode needs at least eight characters, since it alone stands between the public API and open sign-up.

Removed: Invites and the `invites` table, Device Links, the QR code, the `/claim` and `/link` web pages, Cloudflare Access recovery with its Worker settings, and the admin key held in `sessionStorage`. No client pastes a key any more, though Raycast and development builds still read one from their own settings.

Rejected alternatives:

- **Sign in with Apple, gated by TestFlight.** It finds the same Person on every device without a code, but adds an Apple capability, token verification, and a web flow the Host did not want.
- **A sign-in link that carries a key.** One tap to join, but the key lives on in chat history, the Host must send one link per friend, and a lost device still needs the Host.
- **Open sign-up.** The API is public whatever TestFlight does. Strangers could spend Vanta's disk, bandwidth, and provider quotas on Downloads.
- **A hashed passcode.** The Host could not read the current passcode back to tell a friend. The passcode protects only the right to join.
- **A permanent per-Person code.** It would act as a second key that never expires.

Anyone who learns the passcode can join until the Host changes it. A Host who loses every device and Vanta access cannot recover without redeploying. The Host can remove a Person who should not have joined.
