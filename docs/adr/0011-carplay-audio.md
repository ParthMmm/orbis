# CarPlay is an audio client of the iPhone player

A Person should be able to browse Orbis and play Sets while driving. CarPlay is a remote interface: the car draws Apple's templates, and the audio session runs on the iPhone. So CarPlay is a native module in `apps/apple` that drives the existing `AudioPlayer` and `AppModel`, with no second playback stack. It is not Electron, web, or React Native.

Orbis requests the CarPlay Audio entitlement (`com.apple.developer.carplay-audio`) through Apple's form and enables it on the iOS App ID after approval. Device and TestFlight builds wait on that approval.

The root tabs are **Library**, **Playlists**, and **Recent**. Recent orders Sets by the Person's last Listen. Only Sets with Retained Audio are playable, because only those can enter the Listening Queue (ADR 0001). A visible Set saved by a friend plays the same way (ADR 0010).

Playback follows the Listening Queue rules in ADR 0001, the same as the phone. Choosing a Set plays it and keeps the rest of the queue. Choosing a Playlist replaces the queue. The Now Playing template's Up Next shows the queue. When the queue runs out, playback stops.

`AudioPlayer` registers only play and pause remote commands today. Before CarPlay, it gains next track (advance the queue), skip forward and back by 30 seconds, and playback position changes. It does not register previous track: the queue removes a Set when it finishes, so no previous entry exists. These commands also serve the Lock Screen and Bluetooth head units, so they ship without the entitlement.

The car is read and play only: no social switches, key entry, Host commands, Downloads, or library edits.

Rejected alternatives:

- **A Downloads tab of on-device files.** Orbis keeps no audio on the device; ADR 0001 defers offline copies, and a Download is a request for Retained Audio on Vanta. Offline playback in the car needs that deferred decision first.
- **Skip within the list that started playback.** Makes CarPlay a second queue that disagrees with the phone and the server.
- **Previous track restarts or rewinds.** For hour-long Sets, a 30-second skip back is what a driver wants.
- **Custom drawing or Rive on the car screen.** Apple does not allow it for audio apps.
- **CarPlay from the Mac or Electron.** The phone is the CarPlay endpoint.
- **Full social or onboarding in the car.**

CarPlay templates cap list length at about 500 rows and limit stack depth, so Library and Recent paginate or cap. Simulator work can start once the entitlement is on the provisioning profile.
