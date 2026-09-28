import SwiftUI

/// Type ramp. Every style is a Dynamic Type text style, so sizes follow the user's setting.
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
  public static let detail = Font.footnote
  public static let stamp = Font.caption.weight(.semibold)
  public static let label = Font.subheadline.weight(.semibold)
  public static let timecode = Font.title.weight(.semibold)
}

extension Font {
  public static var orbis: OrbisFont.Type { OrbisFont.self }
}
