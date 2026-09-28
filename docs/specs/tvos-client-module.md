# Spec: Orbis tvOS client module

- **ADR:** [`../adr/0012-tvos-client.md`](../adr/0012-tvos-client.md)
- **Research:** [`../research/2026-09-26-tvos.md`](../research/2026-09-26-tvos.md)
- **Related:** [`carplay-audio-module.md`](carplay-audio-module.md)

## Problem Statement

As a Person on the couch, I want Orbis on Apple TV so I can browse my Sets and Playlists and control playback with the Siri Remote. The SwiftUI app already does this on iPhone and Mac; tvOS is not a destination in `project.yml` yet.

## Solution

Add a native tvOS destination to the existing `Orbis` target. Reuse `AppModel` and `AudioPlayer` for connection, Library, Playlists, Search, Listening Queue, and playback. Adapt the shell for focus and viewing distance. Stream Retained Audio from Vanta; keep no Downloads on TV.

## User Stories

1. As a Person, I want Orbis on Apple TV, so playback in the room does not need AirPlay from a phone.
2. As a Person, I want to connect the TV with the service address and my API key, so the TV is another client of my Library.
3. As a Person, I want Home, Library, Playlists, and Search on the TV, matching phone and Mac.
4. As a Person, I want to play a Set through the TV's audio output.
5. As a Person, I want play, pause, and skip from the Siri Remote and system Now Playing.
6. As a Person, I want the TV to use the same Listening Queue as my phone, so a Playlist started on one continues on the other.
7. As a Person, I want artwork-led rails and focus-friendly lists.
8. As a Person, I do not need filing, clipboard capture, or social switches on the TV in v1.
9. As a Person with a large Library, I want Search and filters, so I do not scroll long focus lists.
10. As a Person (later), I want Top Shelf to show recent Sets so I can resume from the home screen.
11. As a Person (later), I want to pair with a short code or QR, so I do not type a key on the remote.

## Implementation Decisions

### Module boundaries

| Module | Responsibility |
| --- | --- |
| `AudioPlayer` (existing) | Only audio engine; Now Playing info; remote commands |
| `AppModel` (existing) | Connection, Library, Playlists, Search, Listening Queue |
| `TVShell` (new) | Focus-first root over the existing `Destination` cases |
| `TVNowPlaying` (new) | Full-screen Now Playing for the remote |
| `TVTopShelf` (slice 2) | `TVTopShelfContentProvider` and deep links |

### Project

- Add `tvOS` to `supportedDestinations` for `Orbis`, `OrbisDesign`, and tests in `apps/apple/project.yml`
- Keep `OrbisShare` off tvOS
- `UIBackgroundModes` includes `audio`
- Deployment target matches the iOS target

### Connection and storage

- Address in defaults and API key in the Keychain, as `ClientSettings` does today
- Artwork cache in the caches directory only
- Audio streams from `sets/{id}/audio` with the Bearer key, as `AudioPlayer` does today

### Testing seams

1. `AudioPlayer` play, pause, seek, and Now Playing on the tvOS destination
2. `TVShell` shows the four destinations
3. Manual: focus traversal and remote play and pause in the Apple TV simulator

## Out of Scope

- TVMLKit
- CarPlay on Apple TV
- `OrbisShare`, clipboard capture, and filing on TV
- Social switches and Host commands
- Offline Library
- Top Shelf as a v1 gate

## Ship order

0. Enable the tvOS destination; fix `#if os` gaps; connect, list the Library, play one Set
1. Focus shell, Home rails, Playlists, Search, Now Playing, queue
2. Top Shelf and deep links
3. Short-code or QR pairing
