# CarPlay is an audio client of the iPhone player

Amended on 2026-10-14 by PR #245. The car's tabs and Home follow the redesigned phone Home, skips are 15 seconds back and 30 seconds ahead, and Up Next shows the playing Set's Tracklist.

A Person should be able to browse Orbis and play Sets while driving. CarPlay is a remote interface: the car draws Apple's templates, and the audio session runs on the iPhone. So CarPlay is a native module in `apps/apple` that drives the existing `AudioPlayer` and `AppModel`, with no second playback stack. It is not Electron, web, or React Native.

Orbis requests the CarPlay Audio entitlement (`com.apple.developer.carplay-audio`) through Apple's form and enables it on the iOS App ID after approval. Device and TestFlight builds wait on that approval.

The root tabs are **Home**, **Library**, and **Playlists**, in the phone's tab order. Home shows the same Sets as the phone's Home, from the same selection: the Set most recently left part-way (or the newest filed), then Continue listening, Recently filed, and Playlists. Only Sets with Retained Audio are playable, because only those can enter the Listening Queue (ADR 0001). A visible Set saved by a friend plays the same way (ADR 0010).

Playback follows the Listening Queue rules in ADR 0001, the same as the phone. Choosing a Set plays it and keeps the rest of the queue. Choosing a Playlist replaces the queue. The Now Playing template's Up Next shows the playing Set's Tracklist, and choosing a Cue plays from it. When the queue runs out, playback stops.

`AudioPlayer` registers play, pause, toggle, skip back 15 seconds, and skip ahead 30 seconds, the same intervals as the phone's transport. Next track (advance the queue) and playback position changes are not registered yet. It does not register previous track: the queue removes a Set when it finishes, so no previous entry exists. These commands also serve the Lock Screen and Bluetooth head units, so they ship without the entitlement.

The car is read and play only: no social switches, key entry, Host commands, Downloads, or library edits.

Rejected alternatives:

- **A Downloads tab of on-device files.** Orbis keeps no audio on the device; ADR 0001 defers offline copies, and a Download is a request for Retained Audio on Vanta. Offline playback in the car needs that deferred decision first.
- **Skip within the list that started playback.** Makes CarPlay a second queue that disagrees with the phone and the server.
- **Previous track restarts or rewinds.** For hour-long Sets, a short skip back is what a driver wants.
- **A Recent tab.** Home's Continue listening rail covers it, and the car's tabs match the phone's.
- **30 seconds in both directions.** The phone skips back 15 seconds, and the car uses the same commands as the Lock Screen.
- **Custom drawing or Rive on the car screen.** Apple does not allow it for audio apps.
- **CarPlay from the Mac or Electron.** The phone is the CarPlay endpoint.
- **Full social or onboarding in the car.**

CarPlay templates cap list length at about 500 rows and limit stack depth, so Library and Home cap their rows. Xcode 27's simulator has no CarPlay display, so the car screen is checked on a device whose provisioning profile carries the entitlement.
