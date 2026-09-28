import SwiftUI

/// One Set, open for reading and for changing.
public struct SetDetail: View {
  public let title: String
  /// The Source Link's name, as the header reads it out.
  public let source: String
  public let creator: String?
  public let length: String?
  public let artwork: URL?
  /// The service could not name this Set, so the name is the caller's to supply or the
  /// service's to try again.
  public let failedToName: Bool
  public let dates: Dates?
  /// How often this Set was started and finished, and when it was last heard. Nil keeps the two
  /// rows off the page entirely, which is what a Set that has never been played shows.
  public let statistics: Statistics?

  /// When the Set was saved and, when the provider named it, when the source released it. The
  /// values are plain and already formatted, because the design system holds no dates of its own.
  public struct Dates: Equatable, Sendable {
    public let imported: String
    public let released: String?

    public init(imported: String, released: String? = nil) {
      self.imported = imported
      self.released = released
    }
  }

  /// How often a Set was listened to and finished, and when it was last heard.
  ///
  /// A Listen is one activation and a Finish is one Listen reaching the end, so the two counts
  /// answer different questions: a Set can be started often and finished rarely. The values are
  /// plain and already formatted, because the design system holds no dates and no counters of its
  /// own.
  public struct Statistics: Equatable, Sendable {
    public let listenCount: Int
    public let finishCount: Int
    /// When the Set was last heard, written as the caller wants it read. Nil before the first one.
    public let lastHeard: String?

    public init(listenCount: Int, finishCount: Int, lastHeard: String? = nil) {
      self.listenCount = listenCount
      self.finishCount = finishCount
      self.lastHeard = lastHeard
    }

    /// True when nothing has been heard, so the page carries no rows about listening at all.
    public var isEmpty: Bool { listenCount == 0 && finishCount == 0 }

    /// "3 · last Thu 11 Sep", or "None yet".
    public var listens: String {
      guard listenCount > 0 else { return "None yet" }
      guard let lastHeard else { return "\(listenCount)" }
      return "\(listenCount) · last \(lastHeard)"
    }

    /// "1", or "None yet" when no Listen has reached the end of the Set.
    public var finishes: String { finishCount > 0 ? "\(finishCount)" : "None yet" }
  }

  public let retryName: () -> Void
  private let transport: AnyView
  /// The rows a person changes the Set with, usually a `SetManagement`. Erased for the same
  /// reason.
  private let management: AnyView

  public init(
    title: String, source: String, creator: String? = nil, length: String? = nil,
    artwork: URL? = nil,
    failedToName: Bool = false,
    dates: Dates? = nil, statistics: Statistics? = nil, retryName: @escaping () -> Void = {},
    @ViewBuilder transport: () -> some View = { EmptyView() },
    @ViewBuilder management: () -> some View
  ) {
    self.title = title
    self.source = source
    self.creator = creator
    self.length = length
    self.artwork = artwork
    self.failedToName = failedToName
    self.dates = dates
    self.statistics = statistics
    self.retryName = retryName
    self.transport = AnyView(transport())
    self.management = AnyView(management())
  }

  /// What the header reads out. The title alone would leave a person wondering which service
  /// the Set came from.
  public static func headerLabel(title: String, source: String) -> String {
    "\(title), \(source)"
  }

  public static func factsLine(dates: Dates?, statistics: Statistics?) -> String? {
    var parts: [String] = []
    if let released = dates?.released { parts.append("Released \(released)") }
    if let imported = dates?.imported { parts.append("Added \(imported)") }
    if let statistics, !statistics.isEmpty {
      let count = statistics.listenCount
      parts.append(count == 1 ? "1 listen" : "\(count) listens")
      switch statistics.finishCount {
      case 0: break
      case 1: parts.append("finished once")
      case let n: parts.append("finished \(n) times")
      }
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  public static func metaLine(
    source: String, length: String?, dates: Dates?, statistics: Statistics?
  ) -> String {
    ([source, length] + [factsLine(dates: dates, statistics: statistics)])
      .compactMap { $0 }
      .joined(separator: " · ")
  }

  /// The line under the artwork: the source, then whatever the caller composed.
  public static func stampLine(source: String, subtitle: String?) -> String {
    [source, subtitle].compactMap { $0 }.joined(separator: " · ")
  }

  public var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        Artwork(url: artwork, seed: title, size: .header)
          .clipShape(.rect(cornerRadius: Radius.row))
          .shadow(color: .black.opacity(0.3), radius: 18, y: 10)
          .padding([.horizontal, .top])
        VStack(spacing: 24) {
          header
          transport
          management
        }
        .padding(.horizontal)
        .padding(.top, 20)
        .padding(.bottom)
      }
    }
    .background { ArtworkBackdrop(url: artwork) }
  }

  private var header: some View {
    VStack(spacing: 6) {
      Text(title)
        .font(.orbis.title)
        .multilineTextAlignment(.center)
        .accessibilityLabel(Self.headerLabel(title: title, source: source))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("detail-title")
      if let creator, !creator.isEmpty {
        Text(creator)
          .font(.title3.weight(.semibold))
          .foregroundStyle(Color.orbis.tint)
          .multilineTextAlignment(.center)
      }
      Text(Self.metaLine(source: source, length: length, dates: dates, statistics: statistics))
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.top, 2)
        .accessibilityIdentifier("detail-facts")
      if failedToName {
        HStack(spacing: 6) {
          Text("Orbis could not name this set.")
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
          Button("Try again", action: retryName)
            .buttonStyle(.plain)
            .font(.orbis.detail.weight(.semibold))
            .foregroundStyle(Color.orbis.tint)
        }
        .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity)
  }

}

public struct SetManagement: View {
  public let tags: [String]
  public let category: @MainActor (String) -> OrbisColor.Category
  public let editTags: () -> Void

  public init(
    tags: [String] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag,
    editTags: @escaping () -> Void
  ) {
    self.tags = tags
    self.category = category
    self.editTags = editTags
  }

  /// What removal costs, said before it happens. The first line always holds; the second only
  /// when Orbis is holding audio for this Set.
  public struct RemovalNotice: Equatable, Sendable {
    public let scope: String
    public let retained: String?
  }

  public static func removalNotice(retainedAudio: Bool) -> RemovalNotice {
    RemovalNotice(
      scope: "This removes the Set from your library. The source is untouched.",
      retained: retainedAudio ? "The audio kept for this Set is removed too." : nil
    )
  }

  public var body: some View {
    ChipFlow(spacing: 8, alignment: .center) {
      ForEach(tags, id: \.self) { tag in
        Button(action: editTags) {
          TagWord(tag, category: category(tag))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Edits Tags")
      }
      Button(tags.isEmpty ? "Add Tags" : "Edit Tags", systemImage: "tag", action: editTags)
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(.secondary)
        .accessibilityIdentifier("detail-tags-row")
    }
    .frame(maxWidth: .infinity)
  }
}

private struct SetDetailSample: View {
  var body: some View {
    SetDetail(
      title: "CHRIS STASSY @ N:A:M:E: Birmingham 22.08.2026",
      source: "YouTube",
      creator: "CHRIS STASSY",
      length: "2h 33m",
      dates: .init(imported: "11 Sep 2026", released: "22 Aug 2026"),
      statistics: .init(listenCount: 3, finishCount: 1, lastHeard: "Thu 11 Sep"),
      management: {
        SetManagement(tags: ["techno", "festival", "hardgroove"], editTags: {})
      }
    )
  }
}

#Preview("Set detail, Mac") { SetDetailSample() }

#Preview("Set detail, Mac, dark") { SetDetailSample().preferredColorScheme(.dark) }

#Preview("Set detail, iPhone") { SetDetailSample().frame(width: 390) }

#Preview("Set detail, iPhone, dark") {
  SetDetailSample().frame(width: 390).preferredColorScheme(.dark)
}

#Preview("Set detail, nothing named yet") {
  SetDetail(
    title: "YouTube video",
    source: "YouTube",
    failedToName: true,
    retryName: {},
    management: { SetManagement(editTags: {}) }
  )
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { SetDetailSample() }
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetDetailSample() }
}
