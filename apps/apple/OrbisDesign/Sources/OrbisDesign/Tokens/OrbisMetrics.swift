import SwiftUI

/// Corner radii. This is the one place Orbis departs from system-supplied values: the radius
/// scale is a design-system decision and lives here only. Spacing has no scale — views use
/// `.padding()` and stack defaults so the system chooses per platform and Dynamic Type.
///
/// Nested surfaces stay concentric: outer radius = inner radius + padding.
///
/// Artwork is rounded like a record sleeve's corner, small in a row and larger on a card, so a
/// Set reads as an object to pick up rather than a cell in a table. `row`, `list` and `hero`
/// are for raised surfaces: cards, sheets, the paste hero, the playlist picker.
public enum Radius {
  /// Artwork in a listing row.
  public static let artwork: CGFloat = 8
  /// Artwork on a card or across the top of a page.
  public static let cover: CGFloat = 12
  public static let chip: CGFloat = 6
  public static let sidebarRow: CGFloat = 8
  public static let button: CGFloat = 10
  public static let row: CGFloat = 12
  public static let field: CGFloat = 14
  public static let list: CGFloat = 16
  public static let hero: CGFloat = 22
}
