import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

nonisolated struct P3: Equatable, Sendable {
  let red: Double
  let green: Double
  let blue: Double

  init(_ red: Double, _ green: Double, _ blue: Double) {
    self.red = red
    self.green = green
    self.blue = blue
  }
}

nonisolated struct DynamicColor: Sendable {
  let light: P3
  let dark: P3
  let increasedContrastLight: P3
  let increasedContrastDark: P3

  func p3(dark isDark: Bool, increasedContrast isIncreasedContrast: Bool) -> P3 {
    switch (isDark, isIncreasedContrast) {
    case (false, false): light
    case (true, false): dark
    case (false, true): increasedContrastLight
    case (true, true): increasedContrastDark
    }
  }

  enum ContrastSetting {
    case increased
    case system
  }

  var color: Color { color(setting: .system) }

  func color(setting: ContrastSetting) -> Color {
    let forced = setting == .increased
    #if canImport(UIKit)
      return Color(
        UIColor { @Sendable traits in
          Self.platformColor(
            self.p3(
              dark: traits.userInterfaceStyle == .dark,
              increasedContrast: forced || traits.accessibilityContrast == .high
            )
          )
        })
    #elseif canImport(AppKit)
      return Color(
        NSColor(name: nil) { @Sendable appearance in
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
