import SwiftUI

/// A card or row that answers the finger: it settles in slightly and dims while pressed, so the
/// press registers before the release opens anything. Reduce Motion keeps the dim, drops the scale.
public struct PressableButtonStyle: ButtonStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    PressableLabel(configuration: configuration)
  }
}

private struct PressableLabel: View {
  let configuration: ButtonStyleConfiguration
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    configuration.label
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
      .opacity(configuration.isPressed ? 0.85 : 1)
      .orbisAnimation(.pressed, value: configuration.isPressed)
  }
}

extension ButtonStyle where Self == PressableButtonStyle {
  public static var orbisPressable: PressableButtonStyle { PressableButtonStyle() }
}
