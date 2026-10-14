import Foundation

struct PositionReporting {
  static let interval = Duration.seconds(5)

  private var lastSent: Int?
  private var lastState: AudioPlayer.PlaybackState?

  mutating func position(
    elapsed: TimeInterval,
    state: AudioPlayer.PlaybackState
  ) -> Int? {
    let seconds = max(Int(elapsed.rounded(.down)), 0)
    guard seconds != lastSent || state != lastState else { return nil }
    lastSent = seconds
    lastState = state
    return seconds
  }

  static func settles(_ state: AudioPlayer.PlaybackState) -> Bool {
    state != .playing
  }
}
