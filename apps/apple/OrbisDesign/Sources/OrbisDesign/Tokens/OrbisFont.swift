import SwiftUI

/// Type ramp. Every style is a Dynamic Type text style, so sizes follow the user's setting
/// and platform. San Francisco is the only family: SF Pro for text, SF Mono for data.
public enum OrbisFont {
  /// Screen title on iPhone ("Library").
  public static let largeTitle = Font.largeTitle.bold()
  /// A Set's title on its own page.
  public static let title = Font.title.bold()
  /// The paste hero headline. Title on Mac, title2 on iPhone — pick with `hero(compact:)`.
  public static func hero(compact: Bool) -> Font {
    compact ? .title2.bold() : .title.bold()
  }
  /// Section heading in content ("Everything / techno").
  public static let sectionTitle = Font.title2.bold()
  /// A Set's title in a row.
  public static let rowTitle = Font.headline
  /// Controls and sidebar rows.
  public static let body = Font.body
  /// Section labels in sidebars and forms.
  public static let caption = Font.caption.weight(.semibold)
  /// URLs, dates, counts, indices.
  public static let mono = Font.system(.caption, design: .monospaced)
  /// Source stamps ("YOUTUBE"). Pair with `.textCase(.uppercase)`.
  public static let stamp = Font.system(.caption2, design: .monospaced).weight(.medium)
  /// Listing labels ("THU 11 SEP", "TAGS"). `ListingLabel` sets the case and tracking.
  public static let label = Font.system(.caption2, design: .monospaced).weight(.medium)
  /// The playhead, read the way a deck shows it. Monospaced so the digits do not shuffle.
  public static let timecode = Font.system(.title, design: .monospaced).weight(.medium)
}

extension Font {
  /// `Font.orbis.rowTitle`, `Font.orbis.mono`, …
  public static var orbis: OrbisFont.Type { OrbisFont.self }
}
