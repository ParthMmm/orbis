# OrbisDesign

The shared design system for the Orbis apps on macOS and iOS: tokens, styles, and components in one SwiftUI package.

- Source of truth: `docs/design/tokens.json`. Run `node scripts/design-tokens.mjs` after editing it to regenerate `Tokens/GeneratedColors.swift` and `docs/design/tokens.css`.
- Colors: `Color.orbis.paper`, `.paperRaised`, `.field`, `.tint`, `.destructive`, and `OrbisColor.Category` (`.dot` for swatches, `.text` for labels). Tint means interactive; category means grouping; red means removal.
- Type: `Font.orbis.*` — Dynamic Type text styles only, SF Pro and SF Mono.
- Radius: `Radius.*` — the one custom scale. Spacing uses system defaults.
- Liquid Glass: standard chrome is glass on recompile. `.orbisGlass()` is for custom floating bars only. Content uses `.orbisRaised()`. The tinted `.orbisPrimary` button is the one glass element inside content.
- Components: `PasteHero`, `SourceStamp`, `TagChip`, `TagPill`, `PlaylistRow`, `SetRow`. Each file carries a `#Preview`.

Requires Xcode 26 or later; platforms iOS 26 and macOS 26.
