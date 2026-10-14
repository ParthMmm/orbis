import SwiftUI

/// Type ramp. Every style is a Dynamic Type text style, so sizes follow the user's setting.
///
/// Headings are SF Pro at bold weights, at the sizes Apple Music uses for its own.
public enum OrbisFont {
  /// Screen title on iPhone ("Library"). tvOS has no large title style and resolves
  /// `.largeTitle` to the 57 pt class, under a section heading's `.title2`, so the TV takes
  /// `.title` (76 pt) to keep a page's title the largest text on it.
  #if os(tvOS)
    public static let largeTitle = Font.title.bold()
  #else
    public static let largeTitle = Font.largeTitle.bold()
  #endif
  /// A Set's title on its own page and on Now Playing.
  public static let title = Font.title2.bold()
  /// The paste hero headline. Title on Mac, title2 on iPhone — pick with `hero(compact:)`.
  public static func hero(compact: Bool) -> Font {
    compact ? .title2.bold() : .title.bold()
  }
  /// Section heading in content ("Recently Filed").
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
