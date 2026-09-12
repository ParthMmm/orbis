import SwiftUI

/// The two settings every component has to survive together: the largest text a person can ask
/// for, and a right-to-left reading direction.
///
/// A component that clips, or that mirrors its edges wrongly, is only visible with both on, so
/// these previews and the layout tests set both at once. `.accessibility5` is the top of the
/// accessibility range, which is stricter than `.xxxLarge`; a row that fits at xxxLarge can
/// still clip at the top of the range.
enum AccessibilityPreview {
  /// The largest text size the system offers.
  static let textSize: DynamicTypeSize = .accessibility5
  static let direction: LayoutDirection = .rightToLeft
}

extension View {
  /// Sets the text size and reading direction a preview or a layout test needs.
  ///
  /// `layoutDirection` is the only physical thing here, and it is the one the system flips:
  /// SwiftUI mirrors the x position of every view inside a container, including a custom
  /// `Layout`, so nothing in this package reads the direction to place things by hand.
  func orbisAccessibilityLayout(
    textSize: DynamicTypeSize = AccessibilityPreview.textSize,
    direction: LayoutDirection = AccessibilityPreview.direction
  ) -> some View {
    dynamicTypeSize(textSize).environment(\.layoutDirection, direction)
  }
}
