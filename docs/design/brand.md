# Brand assets: the icon and the splash

Source of truth for the two raster assets the app ships. `docs/design/tokens.json` owns colour; this owns the orb. Both are already in the app bundle, so nothing here runs at build time.

## The renders

Two Midjourney renders of the same eclipse, and the file each one became:

| Render | Size | Hash (SHA-256, first 24) | Becomes |
| --- | --- | --- | --- |
| `parthmmm_an_orb_--ar_11_….png` | 2048×2048 | `a467e7dbf6e229eb68cbed61` | `AppIcon` |
| `parthmmm_black_--ar_5191_….png` | 1632×2912 | `515137e6d29bc00f297d5f9f` | `Splash` |

The masters live outside the repository. They are named and hashed here so a later render can be told apart from these ones; the derived assets below are what the app draws either way.

## The icon

`apps/apple/Orbis/orbis.icon` is the icon the app ships. Icon Composer owns it, and the target's App Icon name is `orbis`. The flattened appearances it exported are in `docs/design/orbis-icon/`.

`Orbis/Assets.xcassets/AppIcon.appiconset` is the earlier square render, scaled to the renditions the catalog asks for, tagged sRGB, and never cropped. The orb keeps the margin the render gave it, which puts it inside the rounded-rectangle mask Apple applies. The app no longer reads this set.

- iOS takes one 1024 rendition, `ios-1024.png`, and derives the rest.
- macOS takes the classic set, `mac-16.png` through `mac-1024.png`. A single-size entry with `"platform": "macos"` is **rejected** by `actool` in Xcode 26 — no icon is compiled and the partial `Info.plist` comes back empty — so macOS is spelled out size by size.
- Full colour, not indexed. 256 colours thin the orb's streaks and muddy its interior at 1024, which is the size the App Store shows.
- The one image serves every appearance. The render is already dark, so a dark variant would be the same picture, and iOS derives a tinted one.

## The splash

`Orbis/Assets.xcassets/Splash.imageset/splash.png`, drawn by `Orbis/SplashView`.

The tall render fills the screen (`scaledToFill`, cropped to the center where the orb is), so one image lands correctly on every screen size. It is indexed to 256 colours at the render's own resolution, which takes 6.0 MB down to 1.0 MB: the render's field carries grain of ±3 levels, so quantisation error of the same size is hidden inside it. The full-colour version buys nothing a person can see at these levels.

### The field is measured, not chosen

The launch screen needs a flat colour, and a launch screen can only name a colour from a catalog: `Orbis/Assets.xcassets/LaunchField.colorset`, `#060904`.

That value is the render's own field, averaged over the strips around the orb. The field is a gradient, not a flat black — samples across it run from `#040501` to `#0c0f0a` — so no flat colour matches it everywhere, and the best a launch screen can do is match it on average. It is the render's average rather than `paper`'s dark value (`#0d0e14`) because the launch screen has to look like the frame that replaces it: a field that differs from the art by up to 16 levels of blue is a visible step at the moment the app draws its first frame, and a step that arrives later, under a fade, is not.

`LaunchField` is deliberately **not** a token in `docs/design/tokens.json`. It is not a surface a view chooses; it is read from an image, and it is native-only, so it has no meaning in the web palette the generator also writes.

### Why the launch screen has no orb

`UILaunchScreen` holds one image at its natural size, so the orb would be a fixed size in points on every screen — a different share of each — and would jump when the responsive splash replaced it. The launch screen draws the field alone, and the app's first frame puts the orb on that same field: iOS cross-dissolves between the two, so the orb rises out of a black that did not change.

### What the splash does

`Orbis/Splash.swift` holds the timing, `RootView` holds the decision, and the numbers are pinned by `OrbisTests/SplashTimingTests.swift`:

- **Floor, 600 ms.** Below this the orb is a flash frame rather than an opening.
- **Ceiling, 2500 ms.** A service that is slow, or paired but unreachable, must not leave a person looking at a logo where the sentence that explains the wait belongs.
- **Fade, 350 ms.** The app arrives underneath the orb; the exit is the app appearing.
- **Once per launch.** A refresh, a Playlist, a screen change: none of them is an opening.
- **iOS only.** A Mac window that shows a splash before its Library is not how a desktop app opens.
- **No motion on appear.** The orb is simply there in the first frame, so the only animation is the exit, which is a cross-fade — its own Reduce Motion form, since nothing travels.

The fade is an opacity the `.animation(_:value:)` modifier watches, not a `.transition` on an inserted and removed view. A transition on the removal did not play here: the splash cut to the Library with the fade unused. The image is released after the fade, so a screen-sized picture does not stay in memory for the life of the app.

## Regenerating

```sh
SRGB="/System/Library/ColorSync/Profiles/sRGB Profile.icc"
# icon: iOS at 1024, then one PNG per macOS rendition
magick "$SQUARE" -strip -profile "$SRGB" -resize 1024x1024 -define png:compression-level=9 ios-1024.png
# splash: the render at its own size, indexed, no dither
magick "$TALL" -strip -profile "$SRGB" -colors 256 -dither None -define png:compression-level=9 splash.png
```

## Verified

Recorded 2026-09-15 against `fa99269` with the client binary at `b4af59742d0d3710d39c586bfbfaec48…`, on an iPhone 17 Pro simulator (iOS 26.5), in both appearances. Evidence: `/tmp/evidence-orbis-splash/`.

| Claim | Outcome |
| --- | --- |
| The orb covers the first load and hands off to a loaded Library | Verified. Splash visible, then the Library's 9 sets |
| A first run with nothing paired holds the floor and reaches the connection screen | Verified |
| A paired but hanging service leaves the splash at the ceiling | Verified. The failing request was still hanging; the Library showed "Cannot reach your library" with Try again |
| The exit is a cross-fade, not a cut | Verified across seven frames (`handoff-sequence.png`) |
| The icon renders on the Home Screen | Verified (`icon-zoom.png`) |
| The orb is the same picture in dark and light | Verified (`splash-dark.png`, `splash-light.png`), both captured with the hold raised, because a screenshot cannot be made to land inside a 600 ms window |
| The splash does not come back for a reload | Verified. The Library before and after Refresh, no orb (`reload-check.png`) |
| The hold is the floor when the load answers, and the ceiling when it does not | Verified from the app's own log: 0.608 s and 0.678 s against a 0.600 s floor, 2.528 s against a 2.500 s ceiling |

Two measurement traps, because both cost time to find:

- `xcrun simctl io recordVideo` is not a reliable witness here. It stalled its capture for 267 ms across the 350 ms fade, so the recording showed a cut, and on other runs it missed the whole splash. `ffprobe` timestamps settle what the frames cannot, and a deliberately long fade in the same build renders every intermediate frame — which is what proved the code right.
- The ceiling caps the hold; it does not extend it. Raising the floor to make the splash photographable proves nothing, because a load that answers still dismisses at the ceiling. Raise both, or read the log.
