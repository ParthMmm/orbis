import SwiftUI

/// A Person in the Group, as a disc of their colour with their initial. People have no picture,
/// so the colour comes from the username the way a Tag's comes from its name, and stays put.
///
/// A Person listening now carries a green dot at the edge, the one thing the disc says beyond
/// who it is.
public struct PersonAvatar: View {
  public let username: String
  public let diameter: CGFloat
  public let isListening: Bool

  public init(_ username: String, diameter: CGFloat = 44, isListening: Bool = false) {
    self.username = username
    self.diameter = diameter
    self.isListening = isListening
  }

  private var initial: String {
    username.first.map { String($0).uppercased() } ?? "?"
  }

  public var body: some View {
    Circle()
      .fill(OrbisColor.Category.forTag(username).dot.gradient)
      .overlay {
        Text(initial)
          .font(.system(size: diameter * 0.42, weight: .bold, design: .rounded))
          .foregroundStyle(.white)
          .shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
      }
      .frame(width: diameter, height: diameter)
      .overlay(alignment: .bottomTrailing) {
        if isListening {
          Circle()
            .fill(.green)
            .frame(width: diameter * 0.28, height: diameter * 0.28)
            .overlay { Circle().strokeBorder(OrbisColor.paper, lineWidth: 2) }
        }
      }
      .accessibilityHidden(true)
  }
}

#Preview("Avatars") {
  HStack(spacing: 16) {
    PersonAvatar("maya", isListening: true)
    PersonAvatar("jules")
    PersonAvatar("sam", diameter: 96)
  }
  .padding()
  .background(Color.orbis.paper)
}
