import Foundation
import OrbisDesign

/// Everything the design system's row needs, derived from one Set. A value rather than a view
/// so the mapping is testable without rendering anything.
struct SetRowModel {
  let title: String
  let source: String
  let artwork: URL?
  let creator: String?
  let length: String?
  let tags: [SetRow.Tag]
  let added: Date
  let state: SetRow.State?
  /// How far listening got, from 0 to 1, or nothing when the length is unknown.
  let progress: Double?
}

enum SetPresentation {
  /// The design package defaults its types to the main actor, so the mapper that builds them
  /// is main actor too.
  @MainActor
  static func row(_ set: SavedSet, activeTag: String? = nil) -> SetRowModel {
    SetRowModel(
      title: set.title,
      source: set.source.label,
      artwork: set.artworkUrl.flatMap(URL.init(string:)),
      creator: set.creator,
      length: set.durationSeconds.map(length),
      tags: set.tags.map { SetRow.Tag($0, category(for: $0)) },
      added: date(from: set.createdAt),
      state: state(of: set),
      progress: progress(of: set)
    )
  }

  /// The image a Set's own page draws across the width of the window: the largest the provider
  /// offered, or the listing's when a service predates the second image.
  static func pageArtwork(_ set: SavedSet) -> URL? {
    (set.artworkLargeUrl ?? set.artworkUrl).flatMap(URL.init(string:))
  }

  /// The fraction of the Set that has been heard, for the bar along its artwork. Nothing when
  /// the length is unknown, because a bar with no end would claim a place it cannot know.
  static func progress(of set: SavedSet) -> Double? {
    guard let seconds = set.durationSeconds, seconds > 0 else { return nil }
    return min(Double(set.playbackPositionSeconds) / Double(seconds), 1)
  }

  static func sourceSymbol(_ source: SetSource) -> String {
    switch source {
    case .youtube: "play.rectangle.fill"
    case .soundcloud: "cloud.fill"
    case .unknown: "safari"
    }
  }

  static func tagCounts(_ sets: [SavedSet]) -> [String: Int] {
    sets.reduce(into: [:]) { counts, set in
      for tag in Set(set.tags) { counts[tag, default: 0] += 1 }
    }
  }

  static func continueListening(_ sets: [SavedSet], limit: Int = 6) -> [SavedSet] {
    let started = sets.filter { set in
      guard set.playbackPositionSeconds > 0 else { return false }
      guard let progress = progress(of: set) else { return true }
      return progress < 1
    }
    let ordered = started.sorted { ($0.lastListenedAt ?? "") > ($1.lastListenedAt ?? "") }
    return Array(ordered.prefix(limit))
  }

  /// The design shows the link without a scheme or `www.`, because it is there to be
  /// recognised, not followed.
  static func displayURL(_ raw: String) -> String {
    var text = raw
    for prefix in ["https://", "http://"] where text.hasPrefix(prefix) {
      text.removeFirst(prefix.count)
    }
    if text.hasPrefix("www.") {
      text.removeFirst(4)
    }
    return text
  }

  /// A Tag's colour is its identity. The rule lives in the design system, so a Tag looks the
  /// same in every app and in every preview. Main actor because the design package defaults its
  /// types to the main actor, like the other mappers here.
  @MainActor
  static func category(for tag: String) -> OrbisColor.Category {
    OrbisColor.Category.forTag(tag)
  }

  /// The link field speaks in three outcomes: a check in flight, a link the library already
  /// holds, and anything else the service refused.
  @MainActor
  static func linkState(isFiling: Bool, failure: OrbisError?) -> LinkFieldState {
    if isFiling { return .checking }
    guard let failure else { return .idle }
    return failure == .duplicate
      ? .duplicate(message: failure.message)
      : .invalid(message: failure.message)
  }

  @MainActor
  static func state(of set: SavedSet) -> SetRow.State? {
    // Kept audio is a fact the row draws as a symbol; the words are for a Download in flight.
    let kept = set.downloadState == "ready"
    let state = SetRow.State(
      resumeAt: set.playbackPositionSeconds > 0 ? set.playbackPositionSeconds : nil,
      download: kept ? nil : downloadLabel(set.downloadState),
      kept: kept
    )
    return state.isEmpty ? nil : state
  }

  /// What the row's artwork control does for a Set: nothing without Retained Audio, and for
  /// the Set in the player, the change the control makes to it.
  @MainActor
  static func playback(
    of set: SavedSet, currentSetId: String?, isPlaying: Bool
  ) -> SetRow.Playback? {
    guard set.downloadState == "ready" else { return nil }
    guard set.id == currentSetId else { return .ready }
    return isPlaying ? .playing : .paused
  }

  static func downloadLabel(_ downloadState: String) -> String? {
    switch downloadState {
    case "queued": "Download queued"
    case "downloading": "Downloading"
    case "ready": "Audio ready"
    case "failed": "Download failed"
    case "canceled": "Download canceled"
    default: nil
    }
  }

  /// The two timestamp shapes the service sends. A formatter is expensive to build, and one
  /// is built for every visible row on every render, so the pair is built once and reused.
  @MainActor
  private enum DateParsing {
    private static let fractional: ISO8601DateFormatter = {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime]
      return formatter
    }()

    static func date(from timestamp: String) -> Date {
      fractional.date(from: timestamp) ?? whole.date(from: timestamp) ?? .distantPast
    }
  }

  @MainActor
  static func date(from timestamp: String) -> Date {
    DateParsing.date(from: timestamp)
  }

  /// The day a Set was filed, as a listing heads its group: "Thu 11 Sep".
  @MainActor
  static func day(_ timestamp: String) -> String {
    date(from: timestamp).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
  }

  /// A plain date a person can read: "11 Sep 2026".
  @MainActor
  static func plainDate(_ timestamp: String) -> String {
    date(from: timestamp).formatted(
      .dateTime.day().month(.abbreviated).year()
        .locale(Locale(identifier: "en_GB"))
    )
  }

  /// When the Set was saved and, when the provider named it, when it was released.
  @MainActor
  static func datesLine(_ set: SavedSet) -> String {
    var parts = ["Imported \(plainDate(set.createdAt))"]
    if let releasedAt = set.releasedAt {
      parts.append("Released \(plainDate(releasedAt))")
    }
    return parts.joined(separator: " · ")
  }

  /// The line under a Set's title: who made it and how long it runs. Only the parts the
  /// service filled in, so a Set no provider could name shows nothing here.
  @MainActor
  static func subtitle(_ set: SavedSet) -> String? {
    var parts: [String] = []
    if let creator = set.creator, !creator.isEmpty {
      parts.append(creator)
    }
    if let seconds = set.durationSeconds, seconds > 0 {
      parts.append(length(seconds))
    }
    guard !parts.isEmpty else { return nil }
    return parts.joined(separator: " · ")
  }

  static func length(_ seconds: Int) -> String {
    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
  }

  /// A seek position said the way a player says it: m:ss, or h:mm:ss past the hour.
  /// Truncates rather than rounds, so the thumb never claims a second it has not reached.
  static func timestamp(_ seconds: TimeInterval) -> String {
    let total = max(Int(seconds), 0)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let rest = total % 60
    if hours > 0 {
      return String(format: "%d:%02d:%02d", hours, minutes, rest)
    }
    return String(format: "%d:%02d", minutes, rest)
  }

  /// "26:14 · 1:15:25", or the elapsed time alone until the length is known.
  static func miniPlayerTime(elapsed: TimeInterval, duration: TimeInterval?) -> String {
    guard let duration, duration.isFinite, duration > 0 else { return timestamp(elapsed) }
    return "\(timestamp(elapsed)) · \(timestamp(duration))"
  }

  /// The address Open hands to the system. A value rather than a call, so the intent can be
  /// checked without a browser and without leaving the app.
  static func sourceURL(_ set: SavedSet) -> URL? {
    LinkField.address(of: set.url)
  }

  static func timeLeft(_ set: SavedSet) -> String? {
    guard set.playbackPositionSeconds > 0 else { return nil }
    guard let duration = set.durationSeconds, duration > set.playbackPositionSeconds else {
      return playbackPosition(set)
    }
    return "\(length(duration - set.playbackPositionSeconds)) left"
  }

  /// Where playback left off, said the way a person says it, or nothing when it never started.
  static func playbackPosition(_ set: SavedSet) -> String? {
    guard set.playbackPositionSeconds > 0 else { return nil }
    return "\(length(set.playbackPositionSeconds)) in"
  }
}
