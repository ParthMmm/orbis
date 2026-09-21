import SwiftUI

/// One Set, open for reading and for changing.
///
/// The composition is fixed even when the Set is not: the artwork leads, the title is said once,
/// the transport sits under it, and the management rows follow. The rows are `SetManagement`,
/// which the Now Playing screen carries too, so a Set is managed the same way wherever it is
/// met.
public struct SetDetail: View {
  public let title: String
  /// The Source Link's name, as the header reads it out.
  public let source: String
  /// Who made it, how long it runs, when it arrived. Composed by the caller, which knows which
  /// of the three the service filled in.
  public let subtitle: String?
  public let artwork: URL?
  /// Where playback left off, when it has started.
  public let position: String?
  /// How far listening got, from 0 to 1, for the bar along the artwork.
  public let progress: Double?
  /// The service could not name this Set, so the name is the caller's to supply or the
  /// service's to try again.
  public let failedToName: Bool
  /// How often this Set was started and finished, and when it was last heard. Nil keeps the two
  /// rows off the page entirely, which is what a Set that has never been played shows.
  public let statistics: Statistics?

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
  /// Download and playback for this Set, which the app owns. It sits under the position, in the
  /// page, so no bar can cover it. Erased, so the static text helpers stay reachable without a
  /// type parameter.
  private let transport: AnyView
  /// The rows a person changes the Set with, usually a `SetManagement`. Erased for the same
  /// reason.
  private let management: AnyView

  public init(
    title: String, source: String, subtitle: String? = nil, artwork: URL? = nil,
    position: String? = nil, progress: Double? = nil, failedToName: Bool = false,
    statistics: Statistics? = nil, retryName: @escaping () -> Void = {},
    @ViewBuilder transport: () -> some View = { EmptyView() },
    @ViewBuilder management: () -> some View
  ) {
    self.title = title
    self.source = source
    self.subtitle = subtitle
    self.artwork = artwork
    self.position = position
    self.progress = progress
    self.failedToName = failedToName
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

  /// The line under the artwork: the source, then whatever the caller composed.
  public static func stampLine(source: String, subtitle: String?) -> String {
    [source, subtitle].compactMap { $0 }.joined(separator: " · ")
  }

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Artwork(url: artwork, seed: title, size: .header, progress: progress)
        VStack(alignment: .leading, spacing: 16) {
          header
          if failedToName {
            HStack(spacing: 6) {
              Text("Orbis could not name this set.")
                .font(.orbis.mono)
                .foregroundStyle(.secondary)
              Button("Try again", action: retryName)
                .buttonStyle(.plain)
                .foregroundStyle(Color.orbis.tint)
            }
          }
          if let position {
            Text(position)
              .font(.orbis.timecode)
              .monospacedDigit()
              .accessibilityLabel("Resumes at \(position)")
          }
          transport
          if let statistics, !statistics.isEmpty {
            VStack(spacing: 0) {
              ListingRule()
              ListingRow(
                "Listens", value: statistics.listens, identifier: "detail-listens")
              ListingRow(
                "Finishes", value: statistics.finishes, identifier: "detail-finishes")
            }
          }
          management
        }
        .padding()
      }
    }
    .background(Color.orbis.paper)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      ListingLabel(Self.stampLine(source: source, subtitle: subtitle))
      Text(title)
        .font(.orbis.title)
        .accessibilityIdentifier("detail-title")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Self.headerLabel(title: title, source: source))
  }
}

/// The rows a Set is changed with: its Tags, its Playlist, its Source Link, its title, and
/// last, in red, its removal, with the consequences stated before it happens rather than after.
/// Open is the only tinted control, and the one thing a person came to do.
public struct SetManagement: View {
  public let title: String
  /// The Source Link's name, as the row reads it.
  public let source: String
  public let tags: [String]
  /// Audio is kept for this Set, which makes removal mean more than a row.
  public let retainedAudio: Bool

  @Binding public var playlistId: String?
  public let playlists: [PlaylistPicker.Choice]
  public let category: @MainActor (String) -> OrbisColor.Category

  public let open: () -> Void
  public let rename: () -> Void
  public let editTags: () -> Void
  public let remove: () -> Void

  public init(
    title: String, source: String, tags: [String] = [], retainedAudio: Bool = false,
    playlistId: Binding<String?>, playlists: [PlaylistPicker.Choice] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag,
    open: @escaping () -> Void, rename: @escaping () -> Void,
    editTags: @escaping () -> Void, remove: @escaping () -> Void
  ) {
    self.title = title
    self.source = source
    self.tags = tags
    self.retainedAudio = retainedAudio
    _playlistId = playlistId
    self.playlists = playlists
    self.category = category
    self.open = open
    self.rename = rename
    self.editTags = editTags
    self.remove = remove
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
    VStack(alignment: .leading, spacing: 16) {
      VStack(spacing: 0) {
        ListingRule()
        ListingRow("Tags", action: editTags, identifier: "detail-tags-row") {
          if tags.isEmpty {
            Text("None")
              .font(.orbis.mono)
              .foregroundStyle(.secondary)
          } else {
            ChipFlow {
              ForEach(tags, id: \.self) { tag in
                TagWord(tag, category: category(tag))
              }
            }
          }
        }
        ListingRow("Playlist") {
          PlaylistPicker(selection: $playlistId, choices: playlists, category: category)
        }
        ListingRow("Source", value: source) {
          // The one tinted control on the page: the thing a person came here to do.
          Button("Open", action: open)
            .buttonStyle(.plain)
            .fontWeight(.semibold)
            .foregroundStyle(Color.orbis.tint)
            .accessibilityIdentifier("detail-open")
        }
        ListingRow("Title", value: title, action: rename, identifier: "detail-title-row")
      }
      removal
    }
  }

  private var removal: some View {
    let notice = Self.removalNotice(retainedAudio: retainedAudio)
    return VStack(alignment: .leading, spacing: 6) {
      Button("Remove from library", action: remove)
        .buttonStyle(.plain)
        .font(.orbis.mono)
        .foregroundStyle(Color.orbis.destructive)
        .orbisRowHeight()
        .accessibilityIdentifier("detail-remove")
      Text(notice.scope)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
      if let retained = notice.retained {
        Text(retained)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 8)
  }
}

private struct SetDetailSample: View {
  @State private var playlist: String? = "1"
  @State private var none: String?

  var body: some View {
    SetDetail(
      title: "CHRIS STASSY @ N:A:M:E: Birmingham 22.08.2026",
      source: "YouTube",
      subtitle: "CHRIS STASSY · 2h 33m · Sep 11",
      position: "42:00",
      progress: 0.27,
      statistics: .init(listenCount: 3, finishCount: 1, lastHeard: "Thu 11 Sep")
    ) {
      SetManagement(
        title: "CHRIS STASSY @ N:A:M:E: Birmingham 22.08.2026",
        source: "YouTube",
        tags: ["techno", "festival", "hardgroove"],
        playlistId: $playlist,
        playlists: [
          .init(id: "1", name: "Long drives", category: .cyan),
          .init(id: "2", name: "Closing sets", category: .purple),
        ],
        open: {}, rename: {}, editTags: {}, remove: {}
      )
    }
  }
}

#Preview("Set detail, Mac") { SetDetailSample() }

#Preview("Set detail, Mac, dark") { SetDetailSample().preferredColorScheme(.dark) }

#Preview("Set detail, iPhone") { SetDetailSample().frame(width: 390) }

#Preview("Set detail, iPhone, dark") {
  SetDetailSample().frame(width: 390).preferredColorScheme(.dark)
}

#Preview("Set detail, nothing named yet") {
  @Previewable @State var playlist: String?
  return SetDetail(
    title: "YouTube video",
    source: "YouTube",
    failedToName: true,
    retryName: {},
    management: {
      SetManagement(
        title: "YouTube video", source: "YouTube", retainedAudio: true,
        playlistId: $playlist, open: {}, rename: {}, editTags: {}, remove: {}
      )
    }
  )
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { SetDetailSample() }
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetDetailSample() }
}
