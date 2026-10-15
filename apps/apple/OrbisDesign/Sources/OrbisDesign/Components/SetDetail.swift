import SwiftUI

/// One Set, open for reading and for changing.
public struct SetDetail: View {
  public let title: String
  /// The Source Link's name, as the header reads it out.
  public let source: String
  public let creator: String?
  /// Makes the creator a control. Nil leaves it as plain text.
  public let showCreator: (() -> Void)?
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
    /// The release year alone, for the line under the creator. The full date sits in the footer.
    public let releaseYear: String?

    public init(imported: String, released: String? = nil, releaseYear: String? = nil) {
      self.imported = imported
      self.released = released
      self.releaseYear = releaseYear
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
  private let tracklist: AnyView
  /// The rows a person changes the Set with, usually a `SetManagement`. Erased for the same
  /// reason.
  private let management: AnyView

  public init(
    title: String, source: String, creator: String? = nil, showCreator: (() -> Void)? = nil,
    length: String? = nil,
    artwork: URL? = nil,
    failedToName: Bool = false,
    dates: Dates? = nil, statistics: Statistics? = nil, retryName: @escaping () -> Void = {},
    @ViewBuilder transport: () -> some View = { EmptyView() },
    @ViewBuilder tracklist: () -> some View = { EmptyView() },
    @ViewBuilder management: () -> some View
  ) {
    self.title = title
    self.source = source
    self.creator = creator
    self.showCreator = showCreator
    self.length = length
    self.artwork = artwork
    self.failedToName = failedToName
    self.dates = dates
    self.statistics = statistics
    self.retryName = retryName
    self.transport = AnyView(transport())
    self.tracklist = AnyView(tracklist())
    self.management = AnyView(management())
  }

  /// What the header reads out. The title alone would leave a person wondering which service
  /// the Set came from.
  public static func headerLabel(title: String, source: String) -> String {
    "\(title), \(source)"
  }

  /// The line under the creator: the source, the length, and the release year.
  public static func eyebrow(source: String, length: String?, dates: Dates?) -> String {
    [source, length, dates?.releaseYear].compactMap { $0 }.joined(separator: " · ").uppercased()
  }

  /// The facts under the tracklist, one subject per line, so no line breaks inside a phrase.
  public static func footerLines(dates: Dates?, statistics: Statistics?) -> [String] {
    var lines: [String] = []
    var when: [String] = []
    if let released = dates?.released { when.append("Released \(released)") }
    if let imported = dates?.imported { when.append("Added \(imported)") }
    if !when.isEmpty { lines.append(when.joined(separator: " · ")) }
    if let statistics, !statistics.isEmpty {
      let count = statistics.listenCount
      var heard = [count == 1 ? "1 listen" : "\(count) listens"]
      switch statistics.finishCount {
      case 0: break
      case 1: heard.append("finished once")
      case let n: heard.append("finished \(n) times")
      }
      lines.append(heard.joined(separator: " · "))
    }
    return lines
  }

  /// The line under the artwork: the source, then whatever the caller composed.
  public static func stampLine(source: String, subtitle: String?) -> String {
    [source, subtitle].compactMap { $0 }.joined(separator: " · ")
  }

  @State private var titleBottom = CGFloat.infinity
  @State private var showsBarTitle = false
  @State private var topInset: CGFloat = 0
  private static let content = "set-detail-content"

  public var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        Artwork(url: artwork, seed: title, size: .header)
          .shadow(color: .black.opacity(0.18), radius: 18, y: 10)
          .padding(.horizontal, 30)
          .padding(.top, 8)
        VStack(spacing: 20) {
          header
          transport
          management
          tracklist
          footer
        }
        .padding(.horizontal)
        .padding(.top, 18)
        .padding(.bottom, 32)
      }
      .coordinateSpace(.named(Self.content))
      // The glow belongs to the header, so it scrolls away with it rather than staying behind the
      // tracklist. One screen tall, and raised under the bar, where the content does not reach.
      .background(alignment: .top) {
        ArtworkGlow(url: artwork, reach: 0.6)
          .containerRelativeFrame(.vertical) { length, _ in length + topInset }
          .offset(y: -topInset)
      }
    }
    .onScrollGeometryChange(for: CGFloat.self) {
      $0.contentInsets.top
    } action: { _, inset in
      topInset = inset
    }
    // The bar names the Set only once the large title has scrolled under it, as an album does.
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > titleBottom
    } action: { _, scrolledPast in
      showsBarTitle = scrolledPast
    }
    .navigationTitle(showsBarTitle ? title : "")
    .background(Color.orbis.paper)
  }

  @ViewBuilder private var footer: some View {
    let lines = Self.footerLines(dates: dates, statistics: statistics)
    if !lines.isEmpty {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(lines, id: \.self) { Text($0) }
      }
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("detail-facts")
    }
  }

  private var header: some View {
    VStack(spacing: 2) {
      Text(title)
        .font(.orbis.title)
        .multilineTextAlignment(.center)
        .accessibilityLabel(Self.headerLabel(title: title, source: source))
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("detail-title")
        .onGeometryChange(for: CGFloat.self) {
          $0.frame(in: .named(Self.content)).maxY
        } action: {
          titleBottom = $0
        }
      if let creator, !creator.isEmpty {
        let name = Text(creator)
          .font(.title3)
          .foregroundStyle(Color.orbis.tint)
          .multilineTextAlignment(.center)
        if let showCreator {
          Button(action: showCreator) { name }
            .buttonStyle(.plain)
            .accessibilityHint("Shows this creator's sets in the Library")
            .accessibilityIdentifier("detail-creator")
        } else {
          name
        }
      }
      Text(Self.eyebrow(source: source, length: length, dates: dates))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.top, 4)
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

/// A Set's Tags, each one tap from the Library filtered by it, and a "+" to change them.
public struct SetManagement: View {
  public let tags: [String]
  public let category: @MainActor (String) -> OrbisColor.Category
  public let showTag: (String) -> Void
  public let editTags: () -> Void

  public init(
    tags: [String] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag,
    showTag: @escaping (String) -> Void = { _ in },
    editTags: @escaping () -> Void
  ) {
    self.tags = tags
    self.category = category
    self.showTag = showTag
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
    GlassEffectContainer(spacing: 8) {
      ChipFlow(spacing: 8, alignment: .center) {
        ForEach(tags, id: \.self) { tag in
          Button {
            showTag(tag)
          } label: {
            GlassTagChip(tag, category: category(tag))
          }
          .buttonStyle(.plain)
          .accessibilityHint("Shows the Library filtered by \(tag)")
          .accessibilityIdentifier("detail-tag-\(tag)")
        }
        Button(action: editTags) {
          Label(tags.isEmpty ? "Add Tags" : "Edit Tags", systemImage: tags.isEmpty ? "tag" : "plus")
            .labelStyle(AddTagLabelStyle(showsTitle: tags.isEmpty))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, tags.isEmpty ? 14 : 0)
            .frame(minWidth: 40, minHeight: 40)
            .glassEffect(.regular.interactive(), in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tags.isEmpty ? "Add Tags" : "Edit Tags")
        .accessibilityIdentifier("detail-tags-row")
      }
    }
    .frame(maxWidth: .infinity)
  }
}

/// With no Tags the button says what it does; beside Tags it is a "+".
private struct AddTagLabelStyle: LabelStyle {
  let showsTitle: Bool

  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) {
      configuration.icon
      if showsTitle { configuration.title }
    }
  }
}

private struct SetDetailSample: View {
  var body: some View {
    SetDetail(
      title: "CHRIS STASSY @ N:A:M:E: Birmingham 22.08.2026",
      source: "YouTube",
      creator: "CHRIS STASSY",
      length: "2h 33m",
      dates: .init(imported: "11 Sep 2026", released: "22 Aug 2026", releaseYear: "2026"),
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
