# Spec: Orbis tvOS client module

**Date:** 2026-09-26  
**ADR:** [`../adr/0012-tvos-client.md`](../adr/0012-tvos-client.md)  
**Note:** [`../research/2026-09-26-tvos.md`](../research/2026-09-26-tvos.md)  
**Related:** [`carplay-audio-module.md`](carplay-audio-module.md) (iPhone car UI; different runtime)  
**Implementer:** forge (atlas does not write product code)

## Problem Statement

As a Person on the couch, I want Orbis on Apple TV so I can browse my Sets and playlists and control playback with the Siri Remote. The SwiftUI app already does this on iPhone and Mac; tvOS is not a destination in `project.yml` yet.

## Solution

Ship a **native tvOS** destination on the existing `apps/apple` Orbis target. Reuse `AppModel` + `AudioPlayer` for connect, library, playlists, search, queue, and playback. Adapt the shell for focus and the 10-foot UI. Stream retained audio from Vanta; do not invent a Downloads product on TV in v1.

## User Stories

1. As a Person, I want Orbis installable on Apple TV from the same Apple project family, so living-room playback does not require AirPlaying from a phone.
2. As a Person, I want to pair the TV with my Orbis service (address + host-minted device token), so the TV is just another trusted client.
3. As a Person, I want Home / Library / Playlists / Search on the TV, so the destinations match phone and Mac.
4. As a Person, I want to open a Set and play it on the TV speakers/HDMI audio, so the room hears Orbis without a phone in the loop.
5. As a Person, I want play/pause and skip from the Siri Remote / Now Playing, so I am not hunting for on-screen controls.
6. As a Person, I want playlists playable in order with the same stop-at-end queue policy as CarPlay, so mix queues behave predictably.
7. As a Person, I want artwork-forward rails and focus-friendly lists, so browsing works from the couch.
8. As a Person, I do not need to file Sets, paste clipboard links, or flip social toggles on the TV in v1, so the remote UI stays simple.
9. As a developer, I want one `AudioPlayer` on the Apple TV process, so Lock Screen–style Now Playing info and in-app UI cannot desync.
10. As a Person with a large library, I want search and playlist filters, so I am not scrolling endless focus lists.
11. As a Person (later), I want Top Shelf continue-listening / recent Sets, so I can resume without opening the full app first.
12. As a Person pairing a TV, I want a short code or QR path eventually, so I am not typing a long token on the Siri Remote.

## Implementation Decisions

### Module boundaries

| Module | Responsibility |
|---|---|
| **AudioPlayer** (existing) | Sole AVPlayer + session + Now Playing + remote commands on this device |
| **AppModel** (existing) | Library / playlists / search / queue / connection; shared with iOS/macOS |
| **TvShell** (new) | Focus-first root: tab or sidebar mapping `Destination` cases for tvOS |
| **TvNowPlaying** (new or adapted) | Full-screen Now Playing tuned for remote (not iPhone sheet accessory) |
| **TvTopShelf** (slice 2) | `TVTopShelfContentProvider` + deep link into play/display URLs |

tvOS **calls** the same client HTTP APIs as phone/Mac. It must not own Cobalt/download job UI in v1.

### Project / entitlements

- Add `tvOS` to `supportedDestinations` for `Orbis` (+ design package / tests as appropriate) in `apps/apple/project.yml`
- Keep `OrbisShare` off tvOS
- `UIBackgroundModes` = `audio` on the tvOS Info.plist path
- No `carplay-audio` entitlement on the TV target
- Deployment target: align with current Apple stack when forge cuts the destination (do not invent a lower OS just for TV)

### Information architecture

**Root:** Home · Library · Playlists · Search  

**Not in v1 root:** Downloads (CarPlay-only bias), Connection (settings / first-run only), Social, Admin  

**Now Playing:** full-screen from play or mini/focus affordance; system Now Playing stays authoritative for metadata

### Connection / pairing

- v1: `ConnectionView` (or tvOS twin) — service URL + device token, test before save (existing behavior)
- Follow-up slice: short pairing code or QR minted by host / shown on TV, completed on phone — preferred UX, not a v1 blocker if keyboard pairing works

### Queue / skip policy

Identical to CarPlay module:

- Started from playlist → next/prev walks that playlist order
- Started from Library / Search / Home rail → next/prev walks that list window; **at end: stop (no wrap)**
- Shuffle/repeat only if `AudioPlayer` / queue already exposes them

### Data / storage

- Auth: stored device token (fits tiny persistent budget); library lists fetched from service
- Artwork / optional audio cache: **caches directory only** (purgeable). Do not productize as Downloads.
- Play: existing `sets/{id}/audio` stream with bearer token (`AudioPlayer.asset`)

### Testing seams

1. **AudioPlayer** — play/pause/seek/Now Playing still green on tvOS destination (unit + simulator smoke)
2. **Destination mapping** — TvShell shows the same four destinations; no Downloads case
3. **Queue policy** — shared with CarPlay tests where extracted
4. Manual: Apple TV simulator / device focus traversal and remote play/pause

## Out of Scope

- TVMLKit rewrite
- CarPlay on Apple TV
- OrbisShare / clipboard Link Waiting / “File a set” as primary TV flows
- Social toggles, key minting, destructive library admin
- Mana/Rive TV skins
- Guaranteed offline library
- Top Shelf as a v1 ship gate
- Electron or web “cast receiver” as the Orbis TV app

## Default product calls

| Open | Default |
|---|---|
| Destination | Native tvOS on `apps/apple` |
| Player | Existing `AudioPlayer` on the TV device |
| Root IA | Home · Library · Playlists · Search |
| Downloads | No tab in v1 |
| Next at end | Stop |
| Top Shelf | Slice 2 |
| Pairing UX upgrade | Slice 3 (short code / QR) |
| Universal Purchase | Store decision when shipping |

## Ship order (forge)

0. Enable tvOS destination; fix compile/`#if os` gaps; connect + library + play one Set  
1. Focus shell + Home rails + playlists + search + Now Playing + queue parity  
2. Top Shelf + deep links  
3. Short-code / QR pairing  

## Hand-off

Atlas owns this ADR/spec/note under `docs/`. Forge implements in `apps/apple`.
