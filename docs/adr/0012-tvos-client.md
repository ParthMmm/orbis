# ADR 0012: tvOS is a native Apple client of the same player

**Status:** accepted (defaults locked for v1)  
**Date:** 2026-09-26  
**Related:** [ADR 0011](0011-carplay-audio.md) (CarPlay audio)

## Context

Orbis already ships a SwiftUI multiplatform app in `apps/apple` for **iOS** and **macOS** (`project.yml` `supportedDestinations: [iOS, macOS]`). Audio playback, Now Playing metadata, and remote commands live in `AudioPlayer`. Parth asked to spec a **tvOS** app because the Apple target is the natural home — not a greenfield TVML or Electron port.

CarPlay (ADR 0011) is a remote UI on the car with audio on the **iPhone**. tvOS is different: the Apple TV runs Orbis itself and plays audio on the TV’s output while streaming retained audio from Vanta.

## Decision

1. **Home:** add **tvOS** to the existing `Orbis` (and shared design) XcodeGen destinations in `apps/apple`. Native SwiftUI. Not TVMLKit, not Electron, not web-on-TV.
2. **Single player:** reuse `AudioPlayer` / `AppModel` as the sole playback engine on the Apple TV device. No second AVPlayer stack. Same Now Playing + `MPRemoteCommandCenter` surface (Siri Remote play/pause already maps here).
3. **IA (v1):** Home · Library · Playlists · Search — same destinations as iOS/macOS shells, laid out for the focus engine (sidebar / tab + artwork rails), not a CarPlay template tree.
4. **Stream-first:** no **Downloads** product tab on tvOS in v1. Apple TV persistent local storage is tiny; treat on-device media as purgeable cache only. Playback streams Set audio from the service the way phone/Mac already do.
5. **Read/play (+ light library use):** browse and play Sets/playlists; open Set detail; control the queue that `AudioPlayer` already drives. **Out of v1 on TV:** share-extension filing, clipboard Link Waiting, social see/appear toggles, key minting, destructive admin.
6. **Connection:** reuse Person device pairing (address + host-minted device token). Accept on-screen keyboard for v1; prefer a **short pairing code / QR** follow-up slice because Siri Remote text entry is painful.
7. **Queue / skip:** same policy as CarPlay — playlist/queue context; **stop at end (no wrap)**.
8. **Top Shelf:** optional slice after core browse/play works (`TVServices`), not a v1 gate.

## Consequences

- Forge enables `tvOS` in `project.yml`, adds `#if os(tvOS)` focus shells, and keeps `OrbisShare` off tvOS (share extension is phone/Mac).
- Provisioning needs a tvOS App ID / profile (no CarPlay-style entitlement form).
- Universal Purchase (iOS ↔ tvOS) is a store linkage decision, not a code gate.
- Social ADRs 0008–0010 unchanged; tvOS is another client of the same read/play APIs.
- CarPlay module stays iPhone-only; tvOS does not embed CarPlay.

## Rejected

- TVML / client-server markup rewrite (Orbis already has Swift models + player).
- CarPlay templates on Apple TV.
- Promising offline Downloads parity with iPhone (storage model forbids it as a first-class surface).
- Porting Mana-style Rive cinema into Orbis TV (wrong product).
