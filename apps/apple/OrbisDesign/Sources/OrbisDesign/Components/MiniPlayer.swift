import SwiftUI

/// Now playing, docked above the tab bar on every screen but the Set's own page.
///
/// Glass, because it floats over content the way the tab bar does. It shows the Set and its
/// position and offers one control; tapping the rest opens the Set's page, where the transport
/// lives. The bar is the one place playback is reachable after that page closes.
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
  /// "26:14 · 1:15:25", composed by the caller, which owns the clock.
  public let time: String
  public let artwork: URL?
  public let isPlaying: Bool
  public let surface: Surface
  public let toggle: () -> Void
  public let open: () -> Void

  public init(
    title: String, time: String, artwork: URL? = nil, isPlaying: Bool,
    surface: Surface = .floating, toggle: @escaping () -> Void, open: @escaping () -> Void
  ) {
    self.title = title
    self.time = time
    self.artwork = artwork
    self.isPlaying = isPlaying
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
          VStack(alignment: .leading, spacing: 1) {
            Text(title)
              .font(.orbis.rowTitle)
              .lineLimit(1)
            Text(time)
              .font(.orbis.mono)
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
          Spacer(minLength: 0)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Now playing, \(title), \(time)")
      .accessibilityHint("Opens the set")
      Button(action: toggle) {
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
          .font(.title3)
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Self.toggleLabel(isPlaying: isPlaying))
      .accessibilityIdentifier("mini-player-toggle")
    }
    .padding(.horizontal, 8)
    .frame(height: 60)
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
      title: "KETTAMA @ Creamfields 2026", time: "26:14 · 1:15:25", isPlaying: true,
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
      title: "Objekt — Live at Freerotation", time: "1:02:10 · 2:33:00", isPlaying: false,
      toggle: {}, open: {}
    )
    .padding()
  }
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}
