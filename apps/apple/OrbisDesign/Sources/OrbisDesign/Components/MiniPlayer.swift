import SwiftUI

/// Now playing, docked above the tab bar on every screen but the Set's own page.
///
/// Glass, because it floats over content the way the tab bar does. It names the Set and offers
/// one control; the position is the hairline along its bottom edge, and the clock lives on the
/// Now Playing screen, which tapping the rest opens. The bar is the one place playback is
/// reachable after that screen closes.
///
/// On iOS the tab view's bottom accessory is the right home: the system draws that glass and
/// morphs the bar with the tab bar, so the player passes `.accessory` and draws none of its own.
/// Anywhere else it is `.floating` and wears its own.
public struct MiniPlayer: View {
  public enum Surface: Sendable {
    /// The system supplies the glass, as `tabViewBottomAccessory` does.
    case accessory
    /// The player floats on its own and draws Regular glass.
    case floating
  }

  public let title: String
  public let artwork: URL?
  public let isPlaying: Bool
  /// How far listening got, from 0 to 1, for the hairline along the bottom edge.
  public let progress: Double?
  public let surface: Surface
  public let toggle: () -> Void
  public let open: () -> Void

  public init(
    title: String, artwork: URL? = nil, isPlaying: Bool,
    progress: Double? = nil, surface: Surface = .floating,
    toggle: @escaping () -> Void, open: @escaping () -> Void
  ) {
    self.title = title
    self.artwork = artwork
    self.isPlaying = isPlaying
    self.progress = progress
    self.surface = surface
    self.toggle = toggle
    self.open = open
  }

  /// What the control reads out. Named for the change it makes, as a control should be.
  public static func toggleLabel(isPlaying: Bool) -> String {
    isPlaying ? "Pause" : "Play"
  }

  public var body: some View {
    HStack(spacing: 12) {
      Button(action: open) {
        HStack(spacing: 12) {
          Artwork(url: artwork, seed: title, size: .row)
            .frame(width: 62, height: 44)
            .clipShape(.capsule)
          Text(title)
            .font(.orbis.rowTitle)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Now playing, \(title)")
      .accessibilityHint("Opens Now Playing")
      Button(action: toggle) {
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
          .font(.title3)
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .foregroundStyle(Color.orbis.tint)
      .accessibilityLabel(Self.toggleLabel(isPlaying: isPlaying))
      .accessibilityIdentifier("mini-player-toggle")
    }
    .padding(.horizontal, 8)
    .frame(height: 60)
    .overlay(alignment: .bottom) {
      if Artwork.showsProgress(progress), let progress {
        GeometryReader { proxy in
          Color.orbis.tint
            .frame(width: proxy.size.width * progress, height: 2)
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .padding(.horizontal, 20)
        .accessibilityHidden(true)
      }
    }
    .background {
      if surface == .floating {
        Color.clear.orbisGlass(radius: 30, interactive: true)
      }
    }
    .accessibilityIdentifier("mini-player")
  }
}

#Preview("Mini player") {
  VStack {
    Spacer()
    MiniPlayer(
      title: "KETTAMA @ Creamfields 2026", isPlaying: true, progress: 0.34,
      toggle: {}, open: {}
    )
    .padding()
  }
  .background(Color.orbis.paper)
}

#Preview("Mini player, dark") {
  VStack {
    Spacer()
    MiniPlayer(
      title: "Objekt — Live at Freerotation", isPlaying: false, progress: 0.41,
      toggle: {}, open: {}
    )
    .padding()
  }
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}
