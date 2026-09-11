import SwiftUI

/// Corner radii. This is the one place Orbis departs from system-supplied values: the radius
/// scale is a design-system decision and lives here only. Spacing has no scale — views use
/// `.padding()` and stack defaults so the system chooses per platform and Dynamic Type.
///
/// Nested surfaces stay concentric: outer radius = inner radius + padding.
public enum Radius {
  public static let chip: CGFloat = 6
  public static let sidebarRow: CGFloat = 8
  public static let button: CGFloat = 10
  public static let row: CGFloat = 12
  public static let field: CGFloat = 14
  public static let list: CGFloat = 16
  public static let hero: CGFloat = 22
}
