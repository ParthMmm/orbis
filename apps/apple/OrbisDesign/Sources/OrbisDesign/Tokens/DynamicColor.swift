import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// A Display P3 color, components 0…1.
struct P3: Sendable {
  let red: Double
  let green: Double
  let blue: Double

  init(_ red: Double, _ green: Double, _ blue: Double) {
    self.red = red
    self.green = green
    self.blue = blue
  }
}

/// A color with a light and a dark appearance, resolved by the platform at draw time
/// so it follows the window's appearance, not the app's.
struct DynamicColor: Sendable {
  let light: P3
  let dark: P3

  var color: Color {
    #if canImport(UIKit)
      Color(
        UIColor { traits in
          Self.platformColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    #elseif canImport(AppKit)
      Color(
        NSColor(name: nil) { appearance in
          let match = appearance.bestMatch(from: [.aqua, .darkAqua])
          return Self.platformColor(match == .darkAqua ? dark : light)
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
