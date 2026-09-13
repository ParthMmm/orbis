import SwiftUI

/// The two settings every component has to survive together: the largest text a person can ask
/// for, and a right-to-left reading direction.
///
/// A component that clips, or that mirrors its edges wrongly, is only visible with both on, so
/// these previews and the layout tests set both at once. Two text sizes carry the matrix, because
/// they break different things: `.xxxLarge` is the top of the standard range, where a row that
/// still tries to hold one line starts to squeeze its title, and `.accessibility5` is the top of
/// the accessibility range, where a title, three chips, and a date cannot share a line at all.
enum AccessibilityPreview {
  /// The largest text size of the standard range, where the one-line arrangements give way.
  static let standardTextSize: DynamicTypeSize = .xxxLarge
  /// The largest text size the system offers.
  static let textSize: DynamicTypeSize = .accessibility5
  /// Every text size the previews and the layout tests cover, smallest first.
  static let textSizes: [DynamicTypeSize] = [standardTextSize, textSize]
  static let direction: LayoutDirection = .rightToLeft
  /// The widths the matrix is drawn at: the window a Mac gives content, and the phone.
  static let macWidth: CGFloat = 700
  static let phoneWidth: CGFloat = 358
}

/// The same content at every size the matrix covers, so a component carries one Mac-width preview
/// and one iPhone-width preview for the whole matrix rather than one preview for every
/// combination of size and width.
///
/// The size is named above each arrangement, because two copies of the same component in one
/// preview are otherwise hard to tell apart, and which one a person is looking at is the point.
struct AccessibilitySizeMatrix<Content: View>: View {
  let width: CGFloat
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      ForEach(AccessibilityPreview.textSizes, id: \.self) { size in
        VStack(alignment: .leading, spacing: 8) {
          Text(String(describing: size))
            .font(.orbis.caption)
            .foregroundStyle(.secondary)
          content()
            .frame(width: width, alignment: .leading)
            .orbisAccessibilityLayout(textSize: size)
        }
      }
    }
  }
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
