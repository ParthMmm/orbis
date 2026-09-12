# OrbisDesign

The shared design system for the Orbis apps on macOS and iOS: tokens, styles, and components in one SwiftUI package.

- Source of truth: `docs/design/tokens.json`, checked against `docs/design/tokens.schema.json`. Run `bun run tokens:generate` after editing it to regenerate `Tokens/GeneratedColors.swift` and `docs/design/tokens.css`. `bun run tokens:check` fails when a generated file is stale, and `bun run check` runs it. `docs/design/tokens.css` is in `.prettierignore`, because a generated file has to match its source byte for byte.
- Colors: `Color.orbis.paper`, `.paperRaised`, `.field`, `.tint`, `.destructive`, and `OrbisColor.Category` (`.dot` for swatches, `.text` for labels). Tint means interactive; category means grouping; red means removal.
- Type: `Font.orbis.*` — Dynamic Type text styles only, SF Pro and SF Mono.
- Radius: `Radius.*` — the one custom scale. Spacing uses system defaults.
- Liquid Glass: standard chrome is glass on recompile. `.orbisGlass()` is for custom floating bars only. Content uses `.orbisRaised()`. The tinted `.orbisPrimary` button is the one glass element inside content.
- Components: `PasteHero` (which composes `LinkField`), `SourceStamp`, `TagChip`, `TagPill`, `TagInput`, `PlaylistRow`, `PlaylistPicker`, `SetRow`, `SetDetail`, `CopyFailureButton`. Each file carries a `#Preview` at Mac and iPhone widths in light and dark, and at the largest text size in right-to-left layout.
- States: `EmptyLibraryState`, `EmptyPlaylistState`, `NoResultsState`, `UnavailableState`, `LoadingState`. Each names what happened and states its recovery in the button's own words; `UnavailableState` takes an `OrbisFailure` and offers Try again only when retrying could change the answer. `LoadingState` redacts the real `SetRow` layout, so the list does not jump when content arrives.
- Failures: `OrbisFailure` is the heading, sentence, symbol, address, and retryability. `FailureReport` turns one into the text a person pastes into a message. An app maps its own errors to `OrbisFailure` and keeps the vocabulary.
- Motion: `OrbisMotion` names each motion and the effect it plays — `filingSucceeded` bounces, `filingFailed` wiggles, and every motion has a Reduce Motion form. Views ask for the name with `.orbisSymbolEffect(_:trigger:)` or `.orbisAnimation(_:value:)`, never for an ad-hoc animation. Triggers must change only when the motion should play, and no motion loops or runs on appear.
- Rows that can be pressed wear `.orbisRowHeight()`, which gives a touch platform the 44 points a finger needs and leaves a Mac to its pointer.
- Input rules: `LinkField` files a link once it is shaped like one; whether Orbis supports it comes back as state. `TagInput` applies the service's own Tag rules, twenty Tags of forty characters, trimmed, lowercased, and deduplicated, so nothing typed there returns refused.
- Large text and right-to-left: `.orbisAccessibilityLayout()` sets the largest text size and a right-to-left direction for a preview or a layout test. Rows stack instead of squeezing their title, chips reflow through `ChipFlow`, and the paste field drops its button below at accessibility sizes. Disclosures use `chevron.forward`, which the system mirrors, never `chevron.right`.

Requires Xcode 26 or later; platforms iOS 26 and macOS 26.
