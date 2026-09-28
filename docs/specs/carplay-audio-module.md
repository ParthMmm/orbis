# Spec: Orbis CarPlay audio module

**Date:** 2026-09-25  
**ADR:** [`../adr/0011-carplay-audio.md`](../adr/0011-carplay-audio.md)  
**Note:** [`../research/2026-09-25-carplay.md`](../research/2026-09-25-carplay.md)  
**Implementer:** forge (atlas does not write product code)  
**Human gate:** request CarPlay Audio entitlement at https://developer.apple.com/carplay when home

## Problem Statement

As a driver, I want Orbis on CarPlay so I can pick a Set or playlist and control playback without unlocking the phone. Lock Screen / Now Playing already work; the car screen does not show Orbis yet.

## Solution

Ship a CarPlay Audio scene on the iOS app that browses Library / Playlists / Downloads with Apple templates and drives the existing iPhone player. Metadata and transport reuse the shipped Now Playing / remote-command path.

## User Stories

1. As a Person, I want Orbis to appear in CarPlay after Apple approves the audio entitlement, so I can use it in the car.
2. As a driver, I want root tabs for Library, Playlists, and Downloads, so I can find music without hunting.
3. As a driver, I want to open a Set and see it on Now Playing (title, artwork, elapsed), so I know what’s playing.
4. As a driver, I want play/pause and next/prev from the car controls, so I keep my eyes on the road.
5. As a driver, I want playlists listed and playable in order, so mix queues work in the car.
6. As a driver, I want Downloads available when cellular is weak, so playback doesn’t depend on a fresh stream when a file is already retained on device.
7. As a driver, I want long libraries paginated or capped, so CarPlay does not hit template row limits or stall.
8. As a Person, I do not want to paste API keys or flip social toggles in the car, so the car stays glanceable and safe.
9. As a Person, I want the same track state on Lock Screen and CarPlay, so scrubbing or pausing in one place matches the other.
10. As a developer, I want one playback session owned by the iOS player, so CarPlay cannot desync audio.
11. As a Person listening to a friend’s visible Set (social on), I want to play it from CarPlay when the API already allows play, so car parity matches phone read rules.
12. As a Person, I want artwork on list rows and Now Playing when cached, so the car UI stays recognizable without blocking on network.

## Implementation Decisions

### Module boundaries

| Module | Responsibility |
|---|---|
| **PlaybackSession** (existing) | Sole audio engine; Now Playing info; remote commands; queue position |
| **CarPlayScene** (new) | `CPTemplateApplicationScene` lifecycle; connect/disconnect |
| **CarPlayCatalog** (new) | Maps Orbis read models → `CPListTemplate` sections/items; pagination |
| **CarPlayNowPlaying** (new) | Configures `CPNowPlayingTemplate.shared`; does not own audio |
| **CarPlayRouting** (new) | Tab root, push/pop within Apple’s stack depth limit |

CarPlay modules **call** PlaybackSession and library/playlist read APIs. They must not own Cobalt/download jobs in v1 — play only if already playable (local or streamable).

### Entitlements / project

- `com.apple.developer.carplay-audio` after Apple approval
- Background audio already required for Now Playing slice
- Scene manifest for CarPlay template application scene

### Information architecture

**Root tabs:** Library (Sets) · Playlists · Downloads  

**Now Playing:** push `CPNowPlayingTemplate.shared` when playback starts from a list item.

### Queue / skip policy

- Started from playlist → next/prev walks that playlist order
- Started from Library or Downloads → next/prev walks that list window; **at end: stop (no wrap)**
- Shuffle/repeat only if PlaybackSession already exposes them to remote commands

### Data / API

Reuse existing authenticated Person session. Read library Sets, playlists + ordered Set ids, local retained/download index. Play via existing PlaybackSession “play Set” (shared Retained Audio per ADR 0010).

### Testing seams

1. **PlaybackSession remote-command surface** — CarPlay transport matches Lock Screen transitions.
2. **CarPlayCatalog mapper** — Sets/Playlists → list item models + pagination (pure unit tests).
3. **Queue policy** — start context decides next/prev targets.

Manual CarPlay simulator smoke after entitlement; not the primary automated gate.

## Out of Scope

- CarPlay Video, messaging, navigation
- Social toggles, key minting, admin in the car
- Electron / web CarPlay
- Rive or custom drawing on the car display
- Enqueue download from CarPlay (v1)
- CarPlay Ultra / automaker apps

## Default product calls

| Open | Default |
|---|---|
| Entitlement | Parth requests at home; forge scaffolds behind the capability |
| Browse root | Library · Playlists · Downloads |
| Offline bias | Downloads when local items exist |
| Next at end | Stop |
