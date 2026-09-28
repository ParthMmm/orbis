# ADR 0011: CarPlay is an audio client of the Apple player

**Status:** accepted (defaults locked for v1; entitlement is a human gate)  
**Date:** 2026-09-25

## Context

Orbis needs Apple CarPlay so a Person can browse their library and play Sets while driving. Slice 0 already ships: Now Playing metadata and remote commands on the iPhone player. CarPlay must not invent a second playback stack.

## Decision

1. **Category:** CarPlay **Audio** (`com.apple.developer.carplay-audio`). Request via Apple’s CarPlay form; enable on the Orbis iOS App ID after approval.
2. **Home:** native module in `apps/apple` only. Not Electron, not web, not Expo.
3. **Single player:** CarPlay templates are views of the existing iOS playback session (AVAudioSession + MPNowPlayingInfoCenter + MPRemoteCommandCenter). No parallel audio engine.
4. **IA (v1 root tabs):** Library (Sets) · Playlists · Downloads. Prefer Downloads when retained audio is local / network is poor.
5. **Nouns:** browse **Sets** and **Playlists** (Orbis glossary). Playing a visible Set streams shared Retained Audio on Vanta when needed.
6. **Next/prev:** when playing from a playlist or explicit queue, skip within that order; otherwise skip within the list that started playback.
7. **Car is read/play only:** no social toggles, key paste, admin, or library destructive edits from CarPlay.

## Consequences

- Device/TestFlight CarPlay waits on Apple entitlement approval (Parth, at home).
- Simulator work can proceed once entitlement is on the App ID / profile.
- Template limits (~500 rows, shallow stack) force pagination / caps on “All Sets.”
- Social ADRs 0008–0010 unchanged; CarPlay is another client of the same read/play APIs.

## Rejected

- Custom dash UI / Rive on CarPlay (not allowed).
- CarPlay from Mac/Electron (phone is the CarPlay endpoint).
- Full social or onboarding in the car.
