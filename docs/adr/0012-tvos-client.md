# tvOS is a destination of the existing Apple app

The SwiftUI app in `apps/apple` builds for iOS and macOS (`supportedDestinations: [iOS, macOS]`). An Apple TV app should reuse it rather than start again. Unlike CarPlay (ADR 0011), the Apple TV runs Orbis itself and plays audio on its own output, streaming Retained Audio from Vanta.

Orbis adds `tvOS` to the `Orbis` target and the design package in `project.yml`. The app is native SwiftUI with a focus-first shell under `#if os(tvOS)`. `AudioPlayer` and `AppModel` stay the only playback engine and model; the Siri Remote's play and pause already reach `MPRemoteCommandCenter`. `OrbisShare` stays off tvOS.

The root destinations match the other shells: Home, Library, Playlists, and Search. Playback follows the Listening Queue rules in ADR 0001, the same as the phone and CarPlay.

The TV streams only. There is no Downloads tab, and on-device data other than settings is purgeable cache, because tvOS keeps little persistent local storage.

The TV connects like any other client: service address plus a Person's API key (ADR 0008), stored in the Keychain as `ClientSettings` already does. Typing a key on the Siri Remote is painful but works; a short pairing code or QR flow is a follow-up slice.

Out of v1 on TV: share-extension filing, clipboard capture, social switches, key entry beyond pairing, and library edits other than queue control. Top Shelf (`TVServices`) is a slice after core browse and play.

Rejected alternatives:

- **TVMLKit.** Rewrites the client as server markup when Swift models and a player already exist.
- **CarPlay templates on Apple TV.** Different platform and interaction model.
- **Offline Downloads on TV.** The storage model does not support it.
- **`AVPlayerViewController` as Now Playing.** Its chrome is built for video; Orbis plays audio and draws its own Now Playing screen.

A tvOS App ID and profile need no special entitlement. Universal Purchase with iOS is an App Store Connect choice at release, not a code gate.
