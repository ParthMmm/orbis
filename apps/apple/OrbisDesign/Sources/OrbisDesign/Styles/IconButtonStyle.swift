import SwiftUI

/// A bare glyph with a full 44-point target, the minimum the HIG asks of a control. The frame is
/// part of the style, so the whole square takes the tap; a frame set on the Button from outside
/// grows the layout but leaves the target the size of the glyph.
public struct IconButtonStyle: ButtonStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    IconLabel(configuration: configuration)
  }
}

private struct IconLabel: View {
  let configuration: ButtonStyleConfiguration
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    configuration.label
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
      .opacity(isEnabled ? (configuration.isPressed ? 0.5 : 1) : 0.35)
  }
}

extension ButtonStyle where Self == IconButtonStyle {
  public static var orbisIcon: IconButtonStyle { IconButtonStyle() }
}
