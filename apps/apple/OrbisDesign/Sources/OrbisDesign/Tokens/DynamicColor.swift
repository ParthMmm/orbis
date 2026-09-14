import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// A Display P3 color, components 0…1.
struct P3: Equatable, Sendable {
  let red: Double
  let green: Double
  let blue: Double

  init(_ red: Double, _ green: Double, _ blue: Double) {
    self.red = red
    self.green = green
    self.blue = blue
  }
}

/// A color with a value per contrast setting, resolved by the platform at draw time so it
/// follows the window's appearance and Increase Contrast setting, not the app's.
struct DynamicColor: Sendable {
  let light: P3
  let dark: P3
  let increasedContrastLight: P3
  let increasedContrastDark: P3

  /// The value for one combination of appearance and setting. Pure, so a test can name what
  /// each setting resolves to without a window, and so the platform providers below cannot
  /// disagree about which trait means what.
  func p3(dark isDark: Bool, increasedContrast isIncreasedContrast: Bool) -> P3 {
    switch (isDark, isIncreasedContrast) {
    case (false, false): light
    case (true, false): dark
    case (false, true): increasedContrastLight
    case (true, true): increasedContrastDark
    }
  }

  /// Which value a caller wants. `.system` reads the platform traits; `.increased` resolves the
  /// Increase Contrast value for whichever appearance is current, which is what a preview needs
  /// because a preview canvas cannot switch the system setting on.
  enum ContrastSetting {
    case increased
    case system
  }

  var color: Color { color(setting: .system) }

  func color(setting: ContrastSetting) -> Color {
    let forced = setting == .increased
    #if canImport(UIKit)
      return Color(
        UIColor { traits in
          Self.platformColor(
            self.p3(
              dark: traits.userInterfaceStyle == .dark,
              increasedContrast: forced || traits.accessibilityContrast == .high
            )
          )
        })
    #elseif canImport(AppKit)
      return Color(
        NSColor(name: nil) { appearance in
          // The high-contrast names come first: `bestMatch` returns the first name the
          // appearance matches, and only the accessibility names mean Increase Contrast.
          let names: [NSAppearance.Name] =
            forced
            ? [.darkAqua, .aqua]
            : [
              .accessibilityHighContrastDarkAqua,
              .accessibilityHighContrastAqua,
              .darkAqua,
              .aqua,
            ]
          let match = appearance.bestMatch(from: names)
          let isHighContrast =
            forced
            || match == .accessibilityHighContrastDarkAqua
            || match == .accessibilityHighContrastAqua
          let isDark =
            match == .accessibilityHighContrastDarkAqua || (match == .darkAqua && !forced)
          return Self.platformColor(
            self.p3(dark: isDark, increasedContrast: isHighContrast)
          )
        })
    #endif
  }

  #if canImport(UIKit)
    private static func platformColor(_ p3: P3) -> UIColor {
      UIColor(displayP3Red: p3.red, green: p3.green, blue: p3.blue, alpha: 1)
    }
  #elseif canImport(AppKit)
    private static func platformColor(_ p3: P3) -> NSColor {
      NSColor(displayP3Red: p3.red, green: p3.green, blue: p3.blue, alpha: 1)
    }
  #endif
}
