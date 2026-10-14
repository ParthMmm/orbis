import SwiftUI

enum AccessibilityPreview {
  static let standardTextSize: DynamicTypeSize = .xxxLarge
  static let textSize: DynamicTypeSize = .accessibility5
  static let textSizes: [DynamicTypeSize] = [standardTextSize, textSize]
  static let direction: LayoutDirection = .rightToLeft
  static let macWidth: CGFloat = 700
  static let phoneWidth: CGFloat = 358
}

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
  func orbisAccessibilityLayout(
    textSize: DynamicTypeSize = AccessibilityPreview.textSize,
    direction: LayoutDirection = AccessibilityPreview.direction
  ) -> some View {
    dynamicTypeSize(textSize).environment(\.layoutDirection, direction)
  }
}
