import OrbisDesign
import SwiftUI

struct Transport: View {
  let player: AudioPlayer
  let fallbackDuration: TimeInterval?
  var identifierPrefix = "detail"
  var isCurrent = true
  var savedPosition: TimeInterval = 0
  var start: () -> Void = {}
  var leading: AnyView?
  var trailing: AnyView?
  var prominentPlay = true
  var showsCueSkips = false
  var showsControls = true
  var cueStarts: [TimeInterval] = []

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
        identifierPrefix: identifierPrefix,
        cueStarts: cueStarts
      )
      if showsControls {
        HStack {
          if showsCueSkips {
            backButton
            Spacer()
            Button("Previous track", systemImage: "backward.fill") { player.skipToPreviousCue() }
              .font(.system(size: 30))
              .disabled(!isCurrent || !player.canSkipCues)
              .accessibilityIdentifier("\(identifierPrefix)-previous-cue")
            Spacer()
            playButton
            Spacer()
            Button("Next track", systemImage: "forward.fill") { player.skipToNextCue() }
              .font(.system(size: 30))
              .disabled(!isCurrent || player.nextCue == nil)
              .accessibilityIdentifier("\(identifierPrefix)-next-cue")
            Spacer()
            forwardButton
          } else {
            slot(leading)
            Spacer()
            backButton
            Spacer()
            playButton
            Spacer()
            forwardButton
            Spacer()
            slot(trailing)
          }
        }
        .buttonStyle(.orbisIcon)
        .labelStyle(.iconOnly)
        .font(prominentPlay ? .title2 : .title3)
      }
      if isCurrent, case .failed(let message) = player.state {
        Text(message)
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var backButton: some View {
    Button("Back 15 seconds", systemImage: "gobackward.15") {
      player.skip(by: -AudioPlayer.skipBack)
    }
    .disabled(!isCurrent)
    .accessibilityIdentifier("\(identifierPrefix)-back")
  }

  private var forwardButton: some View {
    Button("Forward 30 seconds", systemImage: "goforward.30") {
      player.skip(by: AudioPlayer.skipAhead)
    }
    .disabled(!isCurrent)
    .accessibilityIdentifier("\(identifierPrefix)-forward")
  }

  private var playButton: some View {
    Button(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill") {
      if !isCurrent {
        start()
      } else if isPlaying {
        player.pause()
      } else {
        player.resume()
      }
    }
    .orbisSymbolReplace()
    .playStyle(prominent: prominentPlay)
    .sensoryFeedback(.impact(weight: .medium), trigger: isPlaying)
    .accessibilityIdentifier("\(identifierPrefix)-play-toggle")
  }

  @ViewBuilder private func slot(_ control: AnyView?) -> some View {
    if let control {
      control.frame(width: 44, height: 44)
    } else {
      Color.clear.frame(width: 44, height: 44)
    }
  }
}

private struct PlaybackProgress: View {
  let player: AudioPlayer
  let duration: TimeInterval?
  let isCurrent: Bool
  let savedPosition: TimeInterval
  let identifierPrefix: String
  let cueStarts: [TimeInterval]

  @State private var scrubPosition: TimeInterval?

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
        label: { Text("Position") },
        ticks: {
          SliderTickContentForEach(cueStarts.filter { $0 > 0 && $0 < length }, id: \.self) {
            SliderTick($0)
          }
        },
        onEditingChanged: { editing in
          if !editing, let position = scrubPosition {
            player.seek(to: position)
            scrubPosition = nil
          }
        }
      )
      .disabled(!isCurrent || duration == nil)
      .accessibilityIdentifier("\(identifierPrefix)-seek")
      .accessibilityValue(SetPresentation.timestamp(shown))
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

extension View {
  @ViewBuilder fileprivate func playStyle(prominent: Bool) -> some View {
    if prominent {
      buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.extraLarge)
    } else {
      font(.system(size: 48))
        .frame(width: 76, height: 76)
        .contentShape(.circle)
    }
  }
}
