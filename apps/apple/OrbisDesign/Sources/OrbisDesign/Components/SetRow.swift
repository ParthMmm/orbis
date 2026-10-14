import SwiftUI

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
  public let source: String
  public let artwork: URL?
  public let creator: String?
  public let length: String?
  public let dates: String?
  public let tags: [Tag]
  public let activeTag: String?
  public let state: State?
  /// How far listening got, from 0 to 1, for the bar along the artwork.
  public let progress: Double?
  /// What the artwork's control does, or nothing when there is no Retained Audio to play.
  public let playback: Playback?
  public let togglePlayback: (() -> Void)?
  /// Opens the Set. Absent on a screen that only reads, where the row is not pressable.
  public let select: (() -> Void)?

  public enum Playback: Hashable, Sendable {
    case ready
    case playing
    case paused

    public var symbol: String { self == .playing ? "pause.fill" : "play.fill" }
    public var label: String { self == .playing ? "Pause" : "Play" }
    public var isCurrent: Bool { self != .ready }
    public var announcement: String? {
      switch self {
      case .ready: nil
      case .playing: "Now playing"
      case .paused: "Paused"
      }
    }
  }

  public struct State: Hashable, Sendable {
    public let resumeAt: Int?
    public let download: String?
    public let kept: Bool
    public init(resumeAt: Int? = nil, download: String? = nil, kept: Bool = false) {
      self.resumeAt = resumeAt
      self.download = download
      self.kept = kept
    }
    public var isEmpty: Bool { resumeAt == nil && download == nil && !kept }
    public static let downloadSymbol = "arrow.down.circle"
    public static let keptSymbol = "arrow.down.circle.fill"
    public static let keptLabel = "Audio kept"
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
    length: String? = nil, dates: String? = nil, tags: [Tag] = [], activeTag: String? = nil,
    state: State? = nil,
    progress: Double? = nil, playback: Playback? = nil,
    togglePlayback: (() -> Void)? = nil, select: (() -> Void)? = nil
  ) {
    self.title = title
    self.source = source
    self.artwork = artwork
    self.creator = creator
    self.length = length
    self.dates = dates
    self.tags = tags
    self.activeTag = activeTag
    self.state = state
    self.progress = progress
    self.playback = playback
    self.togglePlayback = togglePlayback
    self.select = select
  }

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
        #if os(macOS)
          HStack(alignment: .center, spacing: 16) {
            artworkControl(size: .row)
            control(select) { columns.contentShape(.rect) }
          }
        #else
          HStack(alignment: .top, spacing: 12) {
            artworkControl(size: .row)
            textControl
          }
        #endif
      }
    }
    .padding(.vertical, 12)
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
        .buttonStyle(.orbisPressable)
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
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
        }
        if let dates, !dates.isEmpty {
          Text(dates)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
        }
        if let state, state.download != nil {
          Image(systemName: State.downloadSymbol)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
        if state?.kept == true {
          Image(systemName: State.keptSymbol)
            .font(.orbis.detail)
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

  private var columns: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.orbis.rowTitle)
          .lineLimit(1)
          .foregroundStyle(playback?.isCurrent == true ? Color.orbis.tint : Color.primary)
        let line = [Self.dataLine(creator: creator, length: nil, state: state), dates ?? ""]
          .filter { !$0.isEmpty }
          .joined(separator: " · ")
        if !line.isEmpty {
          Text(line)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      ChipFlow {
        ForEach(tags) { tag in
          TagWord(tag.name, category: tag.category, active: tag.name == activeTag)
        }
      }
      .frame(width: 220, alignment: .leading)
      Text(length ?? "")
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .frame(width: 90, alignment: .trailing)
      Group {
        if state?.kept == true {
          Image(systemName: State.keptSymbol)
            .accessibilityLabel(State.keptLabel)
        } else if state?.download != nil {
          Image(systemName: State.downloadSymbol)
            .accessibilityHidden(true)
        }
      }
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
      .frame(width: 18)
    }
  }

  private var accessibilityLabel: String {
    var parts = [title, source]
    if let announcement = playback?.announcement { parts.append(announcement) }
    let line = Self.dataLine(creator: creator, length: length, state: state)
    if !line.isEmpty { parts.append(line) }
    if let dates, !dates.isEmpty { parts.append(dates) }
    if state?.kept == true { parts.append(State.keptLabel) }
    if !tags.isEmpty { parts.append(tags.map(\.name).joined(separator: ", ")) }
    return parts.joined(separator: ", ")
  }
}

private struct PlayGlyph: View {
  let playback: SetRow.Playback

  var body: some View {
    Group {
      if playback == .playing {
        EqualizerBars(isPlaying: true, color: .white)
          .frame(height: 12)
      } else {
        Image(systemName: playback.symbol)
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(.white)
      }
    }
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
