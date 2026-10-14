# tvOS is a destination of the existing Apple app

Amended on 2026-10-14 by PR #249. The TV signs in as ADR 0020 describes, and its screens live in `apps/apple/Orbis/TV`.

The SwiftUI app in `apps/apple` builds for iOS and macOS (`supportedDestinations: [iOS, macOS]`). An Apple TV app should reuse it rather than start again. Unlike CarPlay (ADR 0011), the Apple TV runs Orbis itself and plays audio on its own output, streaming Retained Audio from Vanta.

Orbis adds `tvOS` to the `Orbis` target and the design package in `project.yml`. The app is native SwiftUI with a focus-first shell in `apps/apple/Orbis/TV`. `project.yml` leaves the phone and Mac screens out of the tvOS build instead of wrapping them in `#if os(tvOS)`. `AudioPlayer` and `AppModel` stay the only playback engine and model; the Siri Remote's play and pause reach `MPRemoteCommandCenter`, including its toggle command. `OrbisShare` stays off tvOS.

The root destinations match the other shells: Home, Library, Playlists, and Search. Now Playing is a tab while something plays, and Settings is a tab that shows a Sign-in Code for another device and signs out; account changes stay on the phone and Mac. Playback follows the Listening Queue rules in ADR 0001, the same as the phone and CarPlay.

The TV streams only. There is no Downloads tab, and on-device data other than settings is purgeable cache, because tvOS keeps little persistent local storage.

The TV signs in like any other Apple client (ADR 0020): it joins with the Group Passcode or redeems a Sign-in Code shown on a device the Person already uses. It receives its own daily key, stored in the Keychain as `ClientSettings` does, and calls the one fixed address. The eight-character Sign-in Code is short enough to type on the Siri Remote.

Out of v1 on TV: share-extension filing, clipboard capture, social switches, and library edits other than queue control. Top Shelf (`TVServices`) is a slice after core browse and play.

Rejected alternatives:

- **TVMLKit.** Rewrites the client as server markup when Swift models and a player already exist.
- **CarPlay templates on Apple TV.** Different platform and interaction model.
- **Offline Downloads on TV.** The storage model does not support it.
- **`AVPlayerViewController` as Now Playing.** Its chrome is built for video; Orbis plays audio and draws its own Now Playing screen.

A tvOS App ID and profile need no special entitlement. Universal Purchase with iOS is an App Store Connect choice at release, not a code gate.
