import SwiftUI

/// One Set, open for reading and for changing.
///
/// The composition is fixed even when the Set is not: the artwork leads, the title is said once,
/// Open is the only tinted control and the one thing a person came to do, the edit rows are
/// neutral listing rows, and removal sits last in red with the consequences stated before it
/// happens rather than after.
public struct SetDetail: View {
  public let title: String
  /// The Source Link's name, as the header reads it out.
  public let source: String
  /// Who made it, how long it runs, when it arrived. Composed by the caller, which knows which
  /// of the three the service filled in.
  public let subtitle: String?
  public let artwork: URL?
  public let tags: [String]
  /// Where playback left off, when it has started.
  public let position: String?
  /// How far listening got, from 0 to 1, for the bar along the artwork.
  public let progress: Double?
  /// The service could not name this Set, so the name is the caller's to supply or the
  /// service's to try again.
  public let failedToName: Bool
  /// Audio is kept for this Set, which makes removal mean more than a row.
  public let retainedAudio: Bool

  @Binding public var playlistId: String?
  public let playlists: [PlaylistPicker.Choice]
  public let category: @MainActor (String) -> OrbisColor.Category

  @Environment(\.dynamicTypeSize) private var typeSize

  public let open: () -> Void
  public let retryName: () -> Void
  public let rename: () -> Void
  public let editTags: () -> Void
  public let remove: () -> Void
  /// Download and playback for this Set, which the app owns. It sits under the position, in the
  /// page, so no bar can cover it. Erased, so the static text helpers stay reachable without a
  /// type parameter.
  private let transport: AnyView

  public init(
    title: String, source: String, subtitle: String? = nil, artwork: URL? = nil,
    tags: [String] = [], position: String? = nil, progress: Double? = nil,
    failedToName: Bool = false, retainedAudio: Bool = false,
    playlistId: Binding<String?>, playlists: [PlaylistPicker.Choice] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag,
    open: @escaping () -> Void, retryName: @escaping () -> Void = {}, rename: @escaping () -> Void,
    editTags: @escaping () -> Void, remove: @escaping () -> Void,
    @ViewBuilder transport: () -> some View = { EmptyView() }
  ) {
    self.title = title
    self.source = source
    self.subtitle = subtitle
    self.artwork = artwork
    self.tags = tags
    self.position = position
    self.progress = progress
    self.failedToName = failedToName
    self.retainedAudio = retainedAudio
    _playlistId = playlistId
    self.playlists = playlists
    self.category = category
    self.open = open
    self.retryName = retryName
    self.rename = rename
    self.editTags = editTags
    self.remove = remove
    self.transport = AnyView(transport())
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
      tags: ["techno", "festival", "hardgroove"],
      position: "42:00",
      progress: 0.27,
      playlistId: $playlist,
      playlists: [
        .init(id: "1", name: "Long drives", category: .cyan),
        .init(id: "2", name: "Closing sets", category: .purple),
      ],
      open: {}, rename: {}, editTags: {}, remove: {}
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
  @Previewable @State var playlist: String?
  return SetDetail(
    title: "YouTube video",
    source: "YouTube",
    failedToName: true,
    retainedAudio: true,
    playlistId: $playlist,
    open: {}, retryName: {}, rename: {}, editTags: {}, remove: {}
  )
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { SetDetailSample() }
}

#Preview("Set detail, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { SetDetailSample() }
}
