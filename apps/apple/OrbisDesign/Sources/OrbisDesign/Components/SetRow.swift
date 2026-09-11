import SwiftUI

/// One Set in the Library. A grid on regular width, a stack on compact width; same tokens.
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

  public let index: Int
  public let source: String
  public let title: String
  public let url: String
  public let tags: [Tag]
  public let added: Date
  public let activeTag: String?
  public let state: State?

  /// Where listening would resume and what the Download is doing. Both are optional, so a row
  /// with neither renders exactly as before. The design system carries plain values here, as it
  /// does for `source`, so it stays free of the app's domain types.
  public struct State: Hashable, Sendable {
    public let resumeAt: Int?
    public let download: String?

    public init(resumeAt: Int? = nil, download: String? = nil) {
      self.resumeAt = resumeAt
      self.download = download
    }

    public var isEmpty: Bool { resumeAt == nil && download == nil }

    /// "Resume at 1:01:01 · Download queued"
    public var label: String {
      var parts: [String] = []
      if let resumeAt { parts.append("Resume at \(Self.clock(resumeAt))") }
      if let download { parts.append(download) }
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

  @Environment(\.horizontalSizeClass) private var sizeClass

  public init(
    index: Int, source: String, title: String, url: String, tags: [Tag], added: Date,
    activeTag: String? = nil, state: State? = nil
  ) {
    self.index = index
    self.source = source
    self.title = title
    self.url = url
    self.tags = tags
    self.added = added
    self.activeTag = activeTag
    self.state = state
  }

  public var body: some View {
    if sizeClass == .compact {
      compact
    } else {
      regular
    }
  }

  private var regular: some View {
    HStack {
      Text(index, format: .number.precision(.integerLength(2)))
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
      SourceStamp(source)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.orbis.rowTitle)
        Text(url).font(.orbis.mono).foregroundStyle(.secondary).lineLimit(1)
        stateLabel
      }
      Spacer()
      chips
      Text(added, format: .dateTime.day().month(.abbreviated))
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }

  private var compact: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(index, format: .number.precision(.integerLength(2)))
        Text("·")
        Text(source).textCase(.uppercase)
        Spacer()
        Text(added, format: .dateTime.day().month(.abbreviated))
      }
      .font(.orbis.mono)
      .foregroundStyle(.secondary)
      Text(title).font(.orbis.rowTitle)
      stateLabel
      chips
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private var stateLabel: some View {
    if let state, !state.isEmpty {
      Text(state.label)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
  }

  private var chips: some View {
    HStack(spacing: 5) {
      ForEach(tags) { tag in
        TagChip(tag.name, category: tag.category, active: tag.name == activeTag)
      }
    }
  }
}

#Preview("Set rows") {
  List {
    SetRow(
      index: 1, source: "YouTube", title: "Ben UFO — Dekmantel Festival 2019",
      url: "youtube.com/watch?v=dk19benufo",
      tags: [.init("techno", .pink), .init("festival", .purple), .init("breaks", .green)],
      added: .now, activeTag: "techno"
    )
    SetRow(
      index: 2, source: "SoundCloud", title: "Objekt — Live at Freerotation",
      url: "soundcloud.com/objekt/freerotation-2023",
      tags: [.init("techno", .pink), .init("live", .mint)],
      added: .now, activeTag: "techno"
    )
  }
}
