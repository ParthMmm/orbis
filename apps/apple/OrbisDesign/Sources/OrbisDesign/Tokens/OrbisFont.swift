import SwiftUI

public enum OrbisFont {
  /// Screen title on iPhone ("Library"). tvOS has no large title style and resolves
  /// `.largeTitle` to the 57 pt class, under a section heading's `.title2`, so the TV takes
  /// `.title` (76 pt) to keep a page's title the largest text on it.
  #if os(tvOS)
    public static let largeTitle = Font.title.bold()
  #else
    public static let largeTitle = Font.largeTitle.bold()
  #endif
  public static let title = Font.title2.bold()
  public static func hero(compact: Bool) -> Font {
    compact ? .title2.bold() : .title.bold()
  }
  public static let sectionTitle = Font.title2.bold()
  public static let rowTitle = Font.headline
  public static let body = Font.body
  public static let caption = Font.caption.weight(.semibold)
  public static let detail = Font.footnote
  public static let stamp = Font.caption.weight(.semibold)
  public static let label = Font.subheadline.weight(.semibold)
  public static let timecode = Font.title.weight(.semibold)
}

extension Font {
  public static var orbis: OrbisFont.Type { OrbisFont.self }
}
