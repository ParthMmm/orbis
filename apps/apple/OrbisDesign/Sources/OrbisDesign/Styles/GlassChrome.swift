import SwiftUI

/// Liquid Glass for custom chrome — a floating bar or an overlay control group.
///
/// Standard chrome (`NavigationSplitView` sidebar, toolbars, `TabView`, sheets) is glass
/// already; do not wrap it. Content — rows, cards, the paste hero — never gets glass;
/// give it `Color.orbis.paperRaised`. Regular variant only; Clear is not used in Orbis.
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

  /// Content-layer surface: grouped lists, cards, the paste hero.
  public func orbisRaised(radius: CGFloat = Radius.list) -> some View {
    background(Color.orbis.paperRaised, in: .rect(cornerRadius: radius))
  }
}
