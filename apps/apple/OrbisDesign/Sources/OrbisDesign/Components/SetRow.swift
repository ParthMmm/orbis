import SwiftUI

/// One Set in a listing: its artwork, its title, and one line of data under it.
///
/// The data line says who made it and how long it runs, or, once listening has started, where
/// it resumes. Tags follow as `#words`. The row draws no separator of its own; the listing parts
/// rows with hairlines.
///
/// The row has two targets and no mode. The artwork plays when there is Retained Audio to play,
/// and the rest of the row opens the Set, the way a podcast app lays an episode out. A Set is
/// long, and managing one is as common as hearing it, so neither action hides behind the other.
/// The Set in the player is marked in the tint, with a pause glyph while it plays.
public struct SetRow: View {
  public struct Tag: Identifiable, Hashable, Sendable {
    public let name: String
    public let category: OrbisColor.Category
    public var id: String { name }
    public init(_ name: String, _ category: OrbisColor.Category) {
      self.name = name
      self.category = category
    }
  }

  public let title: String
  /// Where the Set came from. Read out, not drawn: the artwork says it well enough.
  public let source: String
  public let artwork: URL?
  public let creator: String?
  /// How long it runs, composed by the caller ("1h 18m").
  public let length: String?
  public let tags: [Tag]
  public let activeTag: String?
  public let state: State?
  /// How far listening got, from 0 to 1, for the bar along the artwork.
  public let progress: Double?
  /// What the artwork's control does, or nothing when there is no Retained Audio to play.
  public let playback: Playback?
  /// Starts, pauses, or resumes the Set, as `playback` says.
  public let togglePlayback: (() -> Void)?
  /// Opens the Set. Absent on a screen that only reads, where the row is not pressable.
  public let select: (() -> Void)?

  /// What the control on the artwork does for this Set.
  public enum Playback: Hashable, Sendable {
    /// Audio is kept and the player holds another Set, or none: the control starts a Listen.
    case ready
    /// This is the Set playing: the control pauses it.
    case playing
    /// This is the Set in the player, paused: the control resumes it.
    case paused

    public var symbol: String { self == .playing ? "pause.fill" : "play.fill" }
    /// Named for the change the control makes, as a control should be.
    public var label: String { self == .playing ? "Pause" : "Play" }
    /// The Set in the player, playing or paused, is the one the row marks.
    public var isCurrent: Bool { self != .ready }
    /// What the row reads out about the player, after the title.
    public var announcement: String? {
      switch self {
      case .ready: nil
      case .playing: "Now playing"
      case .paused: "Paused"
      }
    }
  }

  /// Where listening would resume and what the Download is doing. Both are optional, so a row
  /// with neither renders exactly as before. The design system carries plain values here, as it
  /// does for `source`, so it stays free of the app's domain types.
  public struct State: Hashable, Sendable {
    public let resumeAt: Int?
    /// What a Download in flight is doing ("Download queued"); nothing once it is done.
    public let download: String?
    /// Audio is kept on the device. Drawn as a symbol, because it is a fact about the Set, not
    /// news about it.
    public let kept: Bool
    public init(resumeAt: Int? = nil, download: String? = nil, kept: Bool = false) {
      self.resumeAt = resumeAt
      self.download = download
      self.kept = kept
    }
    public var isEmpty: Bool { resumeAt == nil && download == nil && !kept }
    /// The symbol beside a Download in flight, and the one that stands for kept audio.
    public static let downloadSymbol = "arrow.down.circle"
    public static let keptSymbol = "arrow.down.circle.fill"
    public static let keptLabel = "Audio kept"
    /// "Resume at 1:01:01 · Download queued · Audio kept"
    public var label: String {
      var parts: [String] = []
      if let resumeAt { parts.append("Resume at \(Self.clock(resumeAt))") }
      if let download { parts.append(download) }
      if kept { parts.append(Self.keptLabel) }
      return parts.joined(separator: " · ")
    }
    static func clock(_ seconds: Int) -> String {
      let hours = seconds / 3600
      let minutes = (seconds % 3600) / 60
      let remainder = seconds % 60
      return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
        : String(format: "%d:%02d", minutes, remainder)
    }
  }

  @Environment(\.dynamicTypeSize) private var typeSize

  public init(
    title: String, source: String, artwork: URL? = nil, creator: String? = nil,
    length: String? = nil, tags: [Tag] = [], activeTag: String? = nil, state: State? = nil,
    progress: Double? = nil, playback: Playback? = nil,
    togglePlayback: (() -> Void)? = nil, select: (() -> Void)? = nil
  ) {
    self.title = title
    self.source = source
    self.artwork = artwork
    self.creator = creator
    self.length = length
    self.tags = tags
    self.activeTag = activeTag
    self.state = state
    self.progress = progress
    self.playback = playback
    self.togglePlayback = togglePlayback
    self.select = select
  }

  /// The data line's words. A resume position takes the creator's place, because once a person
  /// has started a Set the question is where they were, not who made it. What the Download is
  /// doing comes last, after the length; kept audio is a symbol, drawn beside the words.
  public static func dataLine(creator: String?, length: String?, state: State?) -> String {
    var parts: [String] = []
    if let resumeAt = state?.resumeAt {
      parts.append("Resume at \(State.clock(resumeAt))")
    } else if let creator, !creator.isEmpty {
      parts.append(creator)
    }
    if let length, !length.isEmpty {
      parts.append(length)
    }
    if let download = state?.download {
      parts.append(download)
    }
    return parts.joined(separator: " · ")
  }

  /// At the largest text sizes the artwork and two lines of text cannot share a row, so the
  /// artwork moves above the text. `.xxxLarge` is the last size of the standard range and the
  /// first where the title loses the room it needs beside the artwork, which is why it is named
  /// rather than left to the accessibility range. The width does not enter into it: a wide row
  /// gains nothing from a title that runs the width of a Mac window beside a thumbnail.
  public static func stacks(dynamicTypeSize: DynamicTypeSize) -> Bool {
    dynamicTypeSize >= .xxxLarge
  }

  public var body: some View {
    Group {
      if Self.stacks(dynamicTypeSize: typeSize) {
        VStack(alignment: .leading, spacing: 8) {
          artworkControl(size: .lead)
          textControl
        }
      } else {
        HStack(alignment: .top, spacing: 12) {
          artworkControl(size: .row)
          textControl
        }
      }
    }
    .padding(.vertical, 12)
    // One element, so a screen reader hears one Set and not two buttons that both name it.
    // Opening is the default action; playing is the named one.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(select == nil ? [] : .isButton)
    .accessibilityAction { select?() }
    .accessibilityActions {
      if let playback, let togglePlayback {
        Button(playback.label, action: togglePlayback)
      }
    }
  }

  /// The artwork plays when it can, and opens the Set when it cannot, so no part of the row
  /// is dead. The glyph says which: it is only drawn when there is audio to play.
  private func artworkControl(size: Artwork.Size) -> some View {
    let art = Artwork(url: artwork, seed: title, size: size, progress: progress)
      .overlay {
        if let playback {
          PlayGlyph(playback: playback)
        }
      }
    return control(playback == nil ? select : togglePlayback ?? select) { art }
  }

  private var textControl: some View {
    control(select) { text.contentShape(.rect) }
  }

  @ViewBuilder
  private func control(_ action: (() -> Void)?, @ViewBuilder content: () -> some View)
    -> some View
  {
    if let action {
      Button(action: action) { content() }
        .buttonStyle(.plain)
    } else {
      content()
    }
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(.orbis.rowTitle)
        .lineLimit(2)
        .foregroundStyle(playback?.isCurrent == true ? Color.orbis.tint : Color.primary)
      let line = Self.dataLine(creator: creator, length: length, state: state)
      ChipFlow {
        if !line.isEmpty {
          Text(line)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        if let state, state.download != nil {
          Image(systemName: State.downloadSymbol)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
        if state?.kept == true {
          Image(systemName: State.keptSymbol)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityLabel(State.keptLabel)
        }
        ForEach(tags) { tag in
          TagWord(tag.name, category: tag.category, active: tag.name == activeTag)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var accessibilityLabel: String {
    var parts = [title, source]
    if let announcement = playback?.announcement { parts.append(announcement) }
    let line = Self.dataLine(creator: creator, length: length, state: state)
    if !line.isEmpty { parts.append(line) }
    if state?.kept == true { parts.append(State.keptLabel) }
    if !tags.isEmpty { parts.append(tags.map(\.name).joined(separator: ", ")) }
    return parts.joined(separator: ", ")
  }
}

/// The control drawn on a row's artwork. Glass, because it sits on an image it must read
/// against, and small enough to leave the artwork legible around it.
private struct PlayGlyph: View {
  let playback: SetRow.Playback

  var body: some View {
    Image(systemName: playback.symbol)
      .font(.system(size: 13, weight: .bold))
      .foregroundStyle(.white)
      .frame(width: 32, height: 32)
      .orbisGlass(radius: 16, interactive: true)
      .accessibilityHidden(true)
  }
}

private struct SetRowSample: View {
  var body: some View {
    VStack(spacing: 0) {
      ListingHeader("Thu 11 Sep")
      SetRow(
        title: "Ben UFO — Dekmantel Festival 2019", source: "YouTube", creator: "Dekmantel",
        length: "1h 58m",
        tags: [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)],
        activeTag: "techno"
      )
      Divider()
      SetRow(
        title: "Objekt — Live at Freerotation", source: "SoundCloud", creator: "Objekt",
        length: "2h 33m", tags: [.init("techno", .pink), .init("live", .mint)],
        activeTag: "techno", state: .init(resumeAt: 2462, kept: true), progress: 0.27,
        playback: .playing, togglePlayback: {}, select: {}
      )
      Divider()
      SetRow(
        title: "DJ Stingray 313 — Dekmantel 2017", source: "YouTube", creator: "Dekmantel",
        length: "1h 12m", state: .init(download: "Download queued")
      )
      Divider()
      SetRow(
        title: "Objekt — Boiler Room Berlin", source: "SoundCloud", creator: "Boiler Room",
        length: "1h 00m", state: .init(kept: true), playback: .ready,
        togglePlayback: {}, select: {}
      )
    }
    .padding(.horizontal)
    .background(Color.orbis.paper)
  }
}

#Preview("Set rows") {
  SetRowSample()
}

#Preview("Set rows, dark") {
  SetRowSample().preferredColorScheme(.dark)
}

#Preview("Set rows, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { SetRowSample() }
}

#Preview("Set rows, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetRowSample() }
}
