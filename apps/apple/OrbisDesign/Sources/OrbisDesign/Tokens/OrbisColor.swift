import SwiftUI

public enum OrbisColor {
  public static let paper = GeneratedColor.paper.color
  public static let paperRaised = GeneratedColor.paperRaised.color
  public static let field = GeneratedColor.field.color
  public static let ink = GeneratedColor.ink.color
  public static let muted = GeneratedColor.muted.color

  public static let tint = GeneratedColor.tint.color
  public static let destructive = Color.red

  public enum Category: String, CaseIterable, Codable, Sendable {
    case pink, yellow, cyan, green, purple, teal, mint, blue, indigo, brown

    public var dot: Color {
      switch self {
      case .pink: .pink
      case .yellow: .yellow
      case .cyan: .cyan
      case .green: .green
      case .purple: .purple
      case .teal: .teal
      case .mint: .mint
      case .blue: .blue
      case .indigo: .indigo
      case .brown: .brown
      }
    }

    public var text: Color { generatedText.color }

    public var increasedContrastText: Color { generatedText.color(setting: .increased) }

    private var generatedText: DynamicColor {
      switch self {
      case .pink: GeneratedColor.categoryPinkText
      case .yellow: GeneratedColor.categoryYellowText
      case .cyan: GeneratedColor.categoryCyanText
      case .green: GeneratedColor.categoryGreenText
      case .purple: GeneratedColor.categoryPurpleText
      case .teal: GeneratedColor.categoryTealText
      case .mint: GeneratedColor.categoryMintText
      case .blue: GeneratedColor.categoryBlueText
      case .indigo: GeneratedColor.categoryIndigoText
      case .brown: GeneratedColor.categoryBrownText
      }
    }

    public var soft: Color {
      dot.opacity(0.18)
    }

    /// A Tag's color is its identity, so it must not change between launches or shift as
    /// other Tags come and go. A stable hash, not the case order, keeps it deterministic and
    /// independent of the rest of the library. Case is folded in, so a Tag that reaches the
    /// display without the service's normalization cannot change color on the way.
    public static func forTag(_ tag: String) -> Self {
      let cases = allCases
      var hash = 5381
      for byte in tag.lowercased().utf8 {
        hash = ((hash << 5) &+ hash) &+ Int(byte)
      }
      return cases[Int(hash.magnitude % UInt(cases.count))]
    }
  }
}

extension Color {
  public static var orbis: OrbisColor.Type { OrbisColor.self }
}
