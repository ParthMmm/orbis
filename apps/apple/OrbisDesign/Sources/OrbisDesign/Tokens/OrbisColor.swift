import SwiftUI

/// Semantic colors for Orbis. Values live in `docs/design/tokens.json`; `GeneratedColors.swift`
/// is generated from it, so change the JSON and run `node scripts/design-tokens.mjs`.
///
/// Rules (Apple HIG, one color one meaning):
/// - `tint` means interactive: the primary action, selection, link hover. One per view.
/// - `Category` colors mean grouping: playlists and tags. Never for actions.
/// - `destructive` is reserved for removal.
/// - Source stamps stay neutral; brand colors of YouTube or SoundCloud are not used.
public enum OrbisColor {
  /// Window and content background. The eclipse: near-black with a violet cast in dark, a
  /// periwinkle-cast off-white in light.
  public static let paper = GeneratedColor.paper.color
  /// Grouped list and card surface, one step above `paper`.
  public static let paperRaised = GeneratedColor.paperRaised.color
  /// Text-field well.
  public static let field = GeneratedColor.field.color
  /// Primary text. Prefer `.primary` in views; this exists for drawing on non-system surfaces.
  public static let ink = GeneratedColor.ink.color
  /// Secondary text. Prefer `.secondary` in views; this exists for drawing on non-system surfaces.
  public static let muted = GeneratedColor.muted.color

  /// The app tint: the orange-coral corona of the eclipse, at the edge of Display P3. A control
  /// color, not body text: it clears Lc 59 on light paper and Lc 54 on dark, enough for fills,
  /// icons, and semibold labels, and it carries its own increased-contrast pair. Warmer than
  /// `destructive`, so the one action on a screen and the one removal on it never read as the
  /// same colour. The asset catalog's AccentColor carries the same values for system chrome.
  public static let tint = GeneratedColor.tint.color
  /// Removal only.
  public static let destructive = Color.red

  /// Grouping color for playlists and tags, from Apple's system palette.
  public enum Category: String, CaseIterable, Codable, Sendable {
    case pink, yellow, cyan, green, purple, teal, mint, blue, indigo, brown

    /// For dots, swatches and fills. The system color: adapts to light, dark and increased contrast.
    public var dot: Color {
      switch self {
      case .pink: .pink
      case .yellow: .yellow
      case .cyan: .cyan
      case .green: .green
      case .purple: .purple
      case .teal: .teal
      case .mint: .mint
      case .blue: .blue
      case .indigo: .indigo
      case .brown: .brown
      }
    }

    /// For text. Same hue as `dot`; every appearance clears Lc 75 on `paper` and `paperRaised`.
    public var text: Color { generatedText.color }

    /// The value the system switches to when Increase Contrast is on. The app reads it through
    /// `text`; this exposes it for a preview canvas, which cannot turn the setting on.
    public var increasedContrastText: Color { generatedText.color(setting: .increased) }

    private var generatedText: DynamicColor {
      switch self {
      case .pink: GeneratedColor.categoryPinkText
      case .yellow: GeneratedColor.categoryYellowText
      case .cyan: GeneratedColor.categoryCyanText
      case .green: GeneratedColor.categoryGreenText
      case .purple: GeneratedColor.categoryPurpleText
      case .teal: GeneratedColor.categoryTealText
      case .mint: GeneratedColor.categoryMintText
      case .blue: GeneratedColor.categoryBlueText
      case .indigo: GeneratedColor.categoryIndigoText
      case .brown: GeneratedColor.categoryBrownText
      }
    }

    /// Translucent fill behind selected chips and pills.
    public var soft: Color {
      dot.opacity(0.18)
    }

    /// A Tag's color is its identity, so it must not change between launches or shift as
    /// other Tags come and go. A stable hash, not the case order, keeps it deterministic and
    /// independent of the rest of the library. Case is folded in, so a Tag that reaches the
    /// display without the service's normalization cannot change color on the way.
    public static func forTag(_ tag: String) -> Self {
      let cases = allCases
      var hash = 5381
      for byte in tag.lowercased().utf8 {
        hash = ((hash << 5) &+ hash) &+ Int(byte)
      }
      return cases[Int(hash.magnitude % UInt(cases.count))]
    }
  }
}

extension Color {
  /// `Color.orbis.paper`, `Color.orbis.tint`, …
  public static var orbis: OrbisColor.Type { OrbisColor.self }
}
