import SwiftUI

public struct OrbisPrimaryButtonStyle: PrimitiveButtonStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    Button(role: configuration.role, action: configuration.trigger) {
      configuration.label
        .font(.orbis.body.weight(.semibold))
    }
    .buttonStyle(.glassProminent)
    .tint(.orbis.tint)
  }
}

public struct OrbisSecondaryButtonStyle: PrimitiveButtonStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    Button(role: configuration.role, action: configuration.trigger) {
      configuration.label
    }
    .buttonStyle(.glass)
  }
}

public struct OrbisDestructiveButtonStyle: PrimitiveButtonStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    Button(role: .destructive, action: configuration.trigger) {
      configuration.label
    }
    .buttonStyle(.borderless)
    .tint(.orbis.destructive)
  }
}

extension PrimitiveButtonStyle where Self == OrbisPrimaryButtonStyle {
  public static var orbisPrimary: OrbisPrimaryButtonStyle { .init() }
}

extension PrimitiveButtonStyle where Self == OrbisSecondaryButtonStyle {
  public static var orbisSecondary: OrbisSecondaryButtonStyle { .init() }
}

extension PrimitiveButtonStyle where Self == OrbisDestructiveButtonStyle {
  public static var orbisDestructive: OrbisDestructiveButtonStyle { .init() }
}
