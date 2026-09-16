import SwiftUI

/// One Set in a listing: its artwork, its title, and one line of data under it.
///
/// The data line says who made it and how long it runs, or, once listening has started, where
/// it resumes. Tags follow as `#words`. The row draws no separator of its own; the listing parts
/// rows with hairlines.
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
    progress: Double? = nil
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
          Artwork(url: artwork, seed: title, size: .lead, progress: progress)
          text
        }
      } else {
        HStack(alignment: .top, spacing: 12) {
          Artwork(url: artwork, seed: title, size: .row, progress: progress)
          text
        }
      }
    }
    .padding(.vertical, 12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(.orbis.rowTitle)
        .lineLimit(2)
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
    let line = Self.dataLine(creator: creator, length: length, state: state)
    if !line.isEmpty { parts.append(line) }
    if state?.kept == true { parts.append(State.keptLabel) }
    if !tags.isEmpty { parts.append(tags.map(\.name).joined(separator: ", ")) }
    return parts.joined(separator: ", ")
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
        activeTag: "techno", state: .init(resumeAt: 2462), progress: 0.27
      )
      Divider()
      SetRow(
        title: "DJ Stingray 313 — Dekmantel 2017", source: "YouTube", creator: "Dekmantel",
        length: "1h 12m", state: .init(download: "Download queued")
      )
      Divider()
      SetRow(
        title: "Objekt — Boiler Room Berlin", source: "SoundCloud", creator: "Boiler Room",
        length: "1h 00m", state: .init(kept: true)
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
