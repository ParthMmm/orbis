import SwiftUI

/// Corner radii. This is the one place Orbis departs from system-supplied values: the radius
/// scale is a design-system decision and lives here only. Spacing has no scale — views use
/// `.padding()` and stack defaults so the system chooses per platform and Dynamic Type.
///
/// Nested surfaces stay concentric: outer radius = inner radius + padding.
///
/// Listings — the Library and a Set's rows — carry no radius at all: artwork is square and
/// rows are parted by hairlines, not held in cards. `row`, `list` and `hero` are for the
/// surfaces that remain raised: sheets, the paste hero, the playlist picker.
public enum Radius {
  /// Provider artwork in a listing. Square, like the thumbnail it came from.
  public static let artwork: CGFloat = 0
  public static let chip: CGFloat = 6
  public static let sidebarRow: CGFloat = 8
  public static let button: CGFloat = 10
  public static let row: CGFloat = 12
  public static let field: CGFloat = 14
  public static let list: CGFloat = 16
  public static let hero: CGFloat = 22
}
