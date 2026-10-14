import SwiftUI

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
