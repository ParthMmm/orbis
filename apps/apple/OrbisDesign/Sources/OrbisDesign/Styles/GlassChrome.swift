import SwiftUI

public struct GlassChrome: ViewModifier {
  let radius: CGFloat
  let interactive: Bool

  public func body(content: Content) -> some View {
    content.glassEffect(
      interactive ? .regular.interactive() : .regular,
      in: .rect(cornerRadius: radius)
    )
  }
}

extension View {
  /// Wrap a custom floating bar in Regular Liquid Glass. Group neighbours in a
  /// `GlassEffectContainer` so they morph and render as one surface.
  public func orbisGlass(radius: CGFloat = Radius.list, interactive: Bool = false) -> some View {
    modifier(GlassChrome(radius: radius, interactive: interactive))
  }

  public func orbisRaised(radius: CGFloat = Radius.list) -> some View {
    background(Color.orbis.paperRaised, in: .rect(cornerRadius: radius))
  }

  public func orbisRowHeight() -> some View {
    #if os(iOS)
      frame(minHeight: 44)
    #else
      self
    #endif
  }
}
