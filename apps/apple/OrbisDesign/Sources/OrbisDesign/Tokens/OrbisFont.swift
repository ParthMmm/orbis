import SwiftUI

/// Type ramp. Every style is a Dynamic Type text style, so sizes follow the user's setting
/// and platform. SF Pro is the only face. Numbers that change while they are read — the
/// playhead, a count — take `.monospacedDigit()` so the digits hold still, not a monospaced face.
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
  /// Secondary facts under a title: who made it, how long it runs, a date, a note.
  public static let detail = Font.footnote
  /// Source stamps ("YouTube").
  public static let stamp = Font.caption.weight(.semibold)
  /// Listing labels: a day heading, a count over a list.
  public static let label = Font.subheadline.weight(.semibold)
  /// The playhead. Pair with `.monospacedDigit()` so the digits do not shuffle.
  public static let timecode = Font.title.weight(.semibold)
}

extension Font {
  /// `Font.orbis.rowTitle`, `Font.orbis.detail`, …
  public static var orbis: OrbisFont.Type { OrbisFont.self }
}
