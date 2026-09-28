import OrbisDesign
import SwiftUI

/// The controls for the Set in the player: the seek bar, the clock, the skips, and Play.
///
/// Shared by the Set's page and the Now Playing screen, so the two never drift. The bar takes
/// the whole width on its own line, the way a music app lays it out: a Set runs an hour or
/// more, and every point of width is seconds of precision. The clock sits under its ends, and
/// the skips beside Play are the fine control the bar cannot give.
struct Transport: View {
  let player: AudioPlayer
  /// The Set's own length, for a bar drawn before the player has measured the audio.
  let fallbackDuration: TimeInterval?
  /// What a journey reads the controls by, so the page and Now Playing stay distinguishable.
  var identifierPrefix = "detail"
  /// Whether this Set is the one in the player. One that is not shows its saved place and a Play
  /// that starts it, in the same layout, so starting playback changes one glyph and nothing moves.
  var isCurrent = true
  /// Where listening left off, for a Set that is not in the player.
  var savedPosition: TimeInterval = 0
  /// Starts this Set, for a Set that is not in the player.
  var start: () -> Void = {}
  /// Controls either side of the skips, such as the queue menu and AirPlay.
  var leading: AnyView?
  var trailing: AnyView?

  /// Loading counts as playing: the person asked for sound, and a buffering pause that flipped
  /// the glyph back to Play and forward again read as the control changing its mind.
  private var isPlaying: Bool {
    guard isCurrent else { return false }
    switch player.state {
    case .playing, .loading: return true
    default: return false
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      PlaybackProgress(
        player: player,
        duration: (isCurrent ? player.duration : nil) ?? fallbackDuration,
        isCurrent: isCurrent,
        savedPosition: savedPosition,
        identifierPrefix: identifierPrefix
      )
      HStack {
        slot(leading)
        Spacer()
        Button("Back 15 seconds", systemImage: "gobackward.15") {
          player.seek(to: player.elapsed - 15)
        }
        .disabled(!isCurrent)
        .accessibilityIdentifier("\(identifierPrefix)-back")
        Spacer()
        Button(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill") {
          if !isCurrent {
            start()
          } else if isPlaying {
            player.pause()
          } else {
            player.resume()
          }
        }
        // The one change starting playback makes on screen: the glyph, replaced in place.
        .contentTransition(.symbolEffect(.replace))
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.extraLarge)
        .accessibilityIdentifier("\(identifierPrefix)-play-toggle")
        Spacer()
        Button("Forward 30 seconds", systemImage: "goforward.30") {
          player.seek(to: player.elapsed + 30)
        }
        .disabled(!isCurrent)
        .accessibilityIdentifier("\(identifierPrefix)-forward")
        Spacer()
        slot(trailing)
      }
      .buttonStyle(.plain)
      .labelStyle(.iconOnly)
      .font(.title2)
      if isCurrent, case .failed(let message) = player.state {
        Text(message)
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
      }
    }
  }

  /// A side control, or the room one would take, so the skips and Play sit in the same place
  /// with or without it.
  @ViewBuilder private func slot(_ control: AnyView?) -> some View {
    if let control {
      control.frame(width: 44, height: 44)
    } else {
      Color.clear.frame(width: 44, height: 44)
    }
  }
}

/// The seek bar and the clock for it, in their own view because the player publishes elapsed time
/// twice a second and SwiftUI redraws the body that read the value. From the page's own body that
/// was the whole page, tag chips and Playlist picker included, on every tick.
private struct PlaybackProgress: View {
  let player: AudioPlayer
  /// The Set's length, or nil while nothing knows it yet.
  let duration: TimeInterval?
  let isCurrent: Bool
  let savedPosition: TimeInterval
  let identifierPrefix: String

  /// Where the person has dragged to but not let go of. Nil is following the player.
  @State private var scrubPosition: TimeInterval?

  /// The position the bar shows and the person sets: the drag they are holding, the player's own
  /// elapsed time, or, for a Set not in the player, where it was left.
  private var position: Binding<TimeInterval> {
    Binding(
      get: { scrubPosition ?? (isCurrent ? player.elapsed : savedPosition) },
      set: { scrubPosition = $0 }
    )
  }

  var body: some View {
    let shown = position.wrappedValue
    let length = duration ?? 0
    VStack(spacing: 4) {
      Slider(
        value: position,
        in: 0...max(length, 1),
        onEditingChanged: { editing in
          if !editing, let position = scrubPosition {
            player.seek(to: position)
            scrubPosition = nil
          }
        }
      )
      // Drawn either way, so the page does not move when playback starts; it takes a drag only
      // once there is audio in the player to move through.
      .disabled(!isCurrent || duration == nil)
      .accessibilityIdentifier("\(identifierPrefix)-seek")
      .accessibilityValue(SetPresentation.timestamp(shown))
      // Elapsed under the left end, what is left under the right, the way a deck reads. While
      // the audio loads the line says so in the same place.
      // The times never leave; a small spinner between them says the audio is on its way, so
      // loading and buffering change nothing else on the line.
      HStack {
        Text(SetPresentation.timestamp(shown))
        Spacer()
        if isCurrent, case .loading = player.state {
          ProgressView()
            .controlSize(.mini)
            .accessibilityLabel("Loading audio")
        }
        Spacer()
        Text(duration.map { "-\(SetPresentation.timestamp(max($0 - shown, 0)))" } ?? "--:--")
      }
      .font(.orbis.detail)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
  }
}
