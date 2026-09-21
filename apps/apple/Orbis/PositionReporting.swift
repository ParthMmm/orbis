import Foundation

/// When a Playback Position is worth sending to the service.
///
/// The rule is kept apart from the loop that sends it, because it is the bound rather than the
/// timing that matters: at most twelve writes a minute of playback, one when playback pauses or
/// resumes, and none at all while the position stands still. Written as a decision on a value, the
/// bound is a thing that can be read and tested instead of a sleep buried in a task.
struct PositionReporting {
  /// How often the player is asked where it is. Five seconds is the twelve-a-minute budget.
  static let interval = Duration.seconds(5)

  /// The last position sent, and the state it was sent in. Both are needed: a pause at the same
  /// second as the last report is still news, because it is where the other device should resume.
  private var lastSent: Int?
  private var lastState: AudioPlayer.PlaybackState?

  /// The position to send, or nil when the service already knows this one.
  mutating func position(
    elapsed: TimeInterval,
    state: AudioPlayer.PlaybackState
  ) -> Int? {
    // Whole seconds, because the service stores whole seconds: a fraction would make two reports
    // of the same second look like two positions.
    let seconds = max(Int(elapsed.rounded(.down)), 0)
    guard seconds != lastSent || state != lastState else { return nil }
    lastSent = seconds
    lastState = state
    return seconds
  }

  /// True when a report settles playback — a pause, or the end of a Set. A settled report is the
  /// one the Library is updated with, because it is the position a row and another device should
  /// now show.
  static func settles(_ state: AudioPlayer.PlaybackState) -> Bool {
    state != .playing
  }
}
