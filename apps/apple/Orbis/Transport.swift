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

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let duration = player.duration ?? fallbackDuration {
        PlaybackProgress(player: player, duration: duration, identifierPrefix: identifierPrefix)
      } else {
        ProgressView()
          .frame(maxWidth: .infinity)
      }
      HStack {
        Button("Back 15 seconds", systemImage: "gobackward.15") {
          player.seek(to: player.elapsed - 15)
        }
        .accessibilityIdentifier("\(identifierPrefix)-back")
        Spacer()
        Button(
          player.state == .playing ? "Pause" : "Play",
          systemImage: player.state == .playing ? "pause.fill" : "play.fill"
        ) {
          if player.state == .playing {
            player.pause()
          } else {
            player.resume()
          }
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.extraLarge)
        .accessibilityIdentifier("\(identifierPrefix)-play-toggle")
        Spacer()
        Button("Forward 30 seconds", systemImage: "goforward.30") {
          player.seek(to: player.elapsed + 30)
        }
        .accessibilityIdentifier("\(identifierPrefix)-forward")
      }
      .buttonStyle(.plain)
      .labelStyle(.iconOnly)
      .font(.title2)
      .padding(.horizontal, 24)
      if case .failed(let message) = player.state {
        Text(message)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
      if case .loading = player.state {
        Text("Loading audio")
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
    }
  }
}

/// The seek bar and the clock for it, in their own view because the player publishes elapsed time
/// twice a second and SwiftUI redraws the body that read the value. From the page's own body that
/// was the whole page, tag chips and Playlist picker included, on every tick.
private struct PlaybackProgress: View {
  let player: AudioPlayer
  let duration: TimeInterval
  let identifierPrefix: String

  /// Where the person has dragged to but not let go of. Nil is following the player.
  @State private var scrubPosition: TimeInterval?

  /// The position the bar shows and the person sets: the drag they are holding, or the player's
  /// own elapsed time while they are not.
  private var position: Binding<TimeInterval> {
    Binding(
      get: { scrubPosition ?? player.elapsed },
      set: { scrubPosition = $0 }
    )
  }

  var body: some View {
    let shown = scrubPosition ?? player.elapsed
    VStack(spacing: 4) {
      Slider(
        value: position,
        in: 0...max(duration, 1),
        onEditingChanged: { editing in
          if !editing, let position = scrubPosition {
            player.seek(to: position)
            scrubPosition = nil
          }
        }
      )
      .accessibilityIdentifier("\(identifierPrefix)-seek")
      .accessibilityValue(SetPresentation.timestamp(shown))
      // Elapsed under the left end, what is left under the right, the way a deck reads.
      HStack {
        Text(SetPresentation.timestamp(shown))
        Spacer()
        Text("-\(SetPresentation.timestamp(max(duration - shown, 0)))")
      }
      .font(.orbis.mono)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
  }
}
