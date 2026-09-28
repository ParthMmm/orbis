# Spec: Orbis CarPlay audio module

**ADR:** [`../adr/0011-carplay-audio.md`](../adr/0011-carplay-audio.md) **Research:** [`../research/2026-09-25-carplay.md`](../research/2026-09-25-carplay.md) **Owner action:** request the CarPlay Audio entitlement at https://developer.apple.com/carplay

## Problem Statement

As a driver, I want Orbis on CarPlay so I can pick a Set or Playlist and control playback without unlocking the phone. Lock Screen play and pause work today; next, skip, and scrubbing do not, and the car screen does not show Orbis.

## Solution

First, finish the remote-command surface on `AudioPlayer`, which also improves the Lock Screen and Bluetooth head units. Then ship a CarPlay Audio scene on the iOS app that browses Library, Playlists, and Recent with Apple's templates and drives the existing player and Listening Queue.

## User Stories

1. As a Person, I want Orbis to appear in CarPlay after Apple approves the audio entitlement.
2. As a driver, I want root tabs for Library, Playlists, and Recent, so I can find a Set without hunting.
3. As a driver, I want to open a Set and see it on Now Playing with title, artwork, and elapsed time.
4. As a driver, I want play, pause, next, and 30-second skips from the car controls.
5. As a driver, I want to play a Playlist in order, replacing the queue as it does on the phone.
6. As a driver, I want Up Next to show the same Listening Queue the phone shows.
7. As a driver, I want long lists paginated or capped, so CarPlay stays within template limits.
8. As a Person, I do not want key entry or social switches in the car.
9. As a Person, I want the same state on Lock Screen and CarPlay, so pausing in one place pauses in the other.
10. As a Person with Social on, I want to play a friend's visible Set from CarPlay under the same rules as the phone.
11. As a driver, I want artwork on rows when cached, so the list stays recognizable without waiting on the network.

## Implementation Decisions

### Slices

0. **Remote commands** (no entitlement): add next track, skip forward and back (30 seconds), and change playback position to `AudioPlayer`. Next advances the Listening Queue through the same path as a finish. Do not register previous track.
1. **Scene and Now Playing** (entitlement): `CPTemplateApplicationScene` delegate, tab root, and `CPNowPlayingTemplate.shared` with Up Next.
2. **Browse:** Library, Playlists, and Recent lists with pagination and cached artwork.

### Module boundaries

| Module | Responsibility |
| --- | --- |
| `AudioPlayer` (existing) | Only audio engine; Now Playing info; remote commands |
| `AppModel` (existing) | Library, Playlists, Listening Queue, and play actions |
| `CarPlayScene` (new) | Scene lifecycle and tab root |
| `CarPlayCatalog` (new) | Maps Sets and Playlists to `CPListItem` models; pagination |

CarPlay modules call `AppModel` play actions (`playSet`, `playPlaylist`). They never touch `AVPlayer` directly or start Downloads.

### Playable Sets

Only Sets with Retained Audio are playable. Rows for other Sets are hidden, not disabled, so a driver never taps a dead row.

### Testing seams

1. `AudioPlayer` remote commands: next advances the queue; skips move the position by 30 seconds.
2. `CarPlayCatalog`: Sets and Playlists map to list items with correct pagination (pure unit tests).
3. Manual smoke in the CarPlay simulator after the entitlement arrives.

## Out of Scope

- On-device audio copies and a Downloads tab (ADR 0001 defers offline copies)
- CarPlay Video, messaging, navigation, CarPlay Ultra
- Social switches, key entry, Host commands in the car
- Starting a Download from CarPlay
- Custom drawing on the car display
