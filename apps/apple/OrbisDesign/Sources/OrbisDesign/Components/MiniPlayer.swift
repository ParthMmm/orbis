import SwiftUI

/// Now playing, docked above the tab bar on every screen but the Set's own page.
///
/// Glass, because it floats over content the way the tab bar does. Tapping it opens Now Playing.
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
  /// The track playing inside the Set, when its Tracklist knows.
  public let subtitle: String?
  public let artwork: URL?
  public let isPlaying: Bool
  /// How far listening got, from 0 to 1, for the hairline along the bottom edge.
  public let progress: Double?
  public let surface: Surface
  /// Where Now Playing zooms out of: the artwork, marked in this namespace.
  public let transition: Namespace.ID?
  public let toggle: () -> Void
  /// Moves to the next track in the Set's Tracklist. Nil when there is no next track.
  public let next: (() -> Void)?
  public let open: () -> Void

  #if os(iOS)
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
  #endif

  /// Squeezed in beside the tab bar after it shrinks on scroll. There is room for the title and
  /// the one control that matters, so the second line and Next step aside.
  private var isInline: Bool {
    #if os(iOS)
      placement == .inline
    #else
      false
    #endif
  }

  public init(
    title: String, subtitle: String? = nil, artwork: URL? = nil, isPlaying: Bool,
    progress: Double? = nil, surface: Surface = .floating, transition: Namespace.ID? = nil,
    toggle: @escaping () -> Void, next: (() -> Void)? = nil, open: @escaping () -> Void
  ) {
    self.title = title
    self.subtitle = subtitle
    self.artwork = artwork
    self.isPlaying = isPlaying
    self.progress = progress
    self.surface = surface
    self.transition = transition
    self.toggle = toggle
    self.next = next
    self.open = open
  }

  /// The id the artwork is marked with, for a zoom into Now Playing.
  public static let transitionID = "now-playing-artwork"

  /// What the control reads out. Named for the change it makes, as a control should be.
  public static func toggleLabel(isPlaying: Bool) -> String {
    isPlaying ? "Pause" : "Play"
  }

  public var body: some View {
    HStack(spacing: 4) {
      Button(action: open) {
        HStack(spacing: 12) {
          Artwork(url: artwork, seed: title, size: .row, cornerRadius: 6)
            .frame(width: 64, height: 36)
            .transitionSource(in: transition)
          VStack(alignment: .leading, spacing: 1) {
            Text(subtitle ?? title)
              .font(.subheadline.weight(.semibold))
              .lineLimit(1)
              .contentTransition(.opacity)
              .orbisAnimation(.cueChanged, value: subtitle)
            if subtitle != nil, !isInline {
              Text(title)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Now playing, \(title)")
      .accessibilityHint("Opens Now Playing")
      Button(action: toggle) {
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
          .font(.title2)
          .orbisSymbolReplace()
      }
      .sensoryFeedback(.impact(weight: .light), trigger: isPlaying)
      .buttonStyle(.orbisIcon)
      .foregroundStyle(.primary)
      .accessibilityLabel(Self.toggleLabel(isPlaying: isPlaying))
      .accessibilityIdentifier("mini-player-toggle")
      if !isInline {
        Button("Next track", systemImage: "forward.fill") { next?() }
          .labelStyle(.iconOnly)
          .font(.title3)
          .buttonStyle(.orbisIcon)
          .disabled(next == nil)
          .accessibilityIdentifier("mini-player-next")
      }
    }
    .padding(.horizontal, 8)
    .frame(height: isInline ? nil : 60)
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
      title: "KETTAMA @ Creamfields 2026", subtitle: "Overmono · So U Kno", isPlaying: true,
      progress: 0.34,
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

extension View {
  @ViewBuilder fileprivate func transitionSource(in namespace: Namespace.ID?) -> some View {
    if let namespace {
      matchedTransitionSource(id: MiniPlayer.transitionID, in: namespace) {
        $0.clipShape(RoundedRectangle(cornerRadius: 22))
      }
    } else {
      self
    }
  }
}
