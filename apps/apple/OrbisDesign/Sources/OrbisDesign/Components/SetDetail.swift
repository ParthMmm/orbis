import SwiftUI

/// One Set, open for reading and for changing.
///
/// The composition is fixed even when the Set is not: Open is the only tinted control and the
/// one thing a person came to do, the two edit rows are neutral, and removal sits last in red
/// with the consequences stated before it happens rather than after.
public struct SetDetail: View {
  public let title: String
  /// The Source Link's name, as `SourceStamp` draws it.
  public let source: String
  /// Who made it, how long it runs, when it arrived. Composed by the caller, which knows which
  /// of the three the service filled in.
  public let subtitle: String?
  public let tags: [String]
  /// Where playback left off, when it has started.
  public let position: String?
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

  public init(
    title: String, source: String, subtitle: String? = nil, tags: [String] = [],
    position: String? = nil, failedToName: Bool = false, retainedAudio: Bool = false,
    playlistId: Binding<String?>, playlists: [PlaylistPicker.Choice] = [],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag,
    open: @escaping () -> Void, retryName: @escaping () -> Void = {}, rename: @escaping () -> Void,
    editTags: @escaping () -> Void, remove: @escaping () -> Void
  ) {
    self.title = title
    self.source = source
    self.subtitle = subtitle
    self.tags = tags
    self.position = position
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

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        Button("Open", action: open)
          .buttonStyle(.orbisPrimary)
          .accessibilityIdentifier("detail-open")
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
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        VStack(spacing: 0) {
          DetailRow(label: "Tags", action: editTags, identifier: "detail-tags-row") {
            if tags.isEmpty {
              Text("None")
                .foregroundStyle(.secondary)
            } else {
              ChipFlow {
                ForEach(tags, id: \.self) { tag in
                  TagChip(tag, category: category(tag))
                }
              }
            }
          }
          Divider()
          PlaylistPicker(selection: $playlistId, choices: playlists, category: category)
            .padding(.vertical, 10)
          Divider()
          DetailRow(
            label: "Title", value: title, action: rename, identifier: "detail-title-row")
        }
        .padding(.horizontal)
        .orbisRaised()
        removal
      }
      .padding()
    }
    .background(Color.orbis.paper)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.orbis.sectionTitle)
        .accessibilityIdentifier("detail-title")
      // The stamp and the subtitle sit on one line until the text grows too large for both.
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 2) {
          SourceStamp(source)
          subtitleText
        }
      } else {
        HStack(spacing: 8) {
          SourceStamp(source)
          subtitleText
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Self.headerLabel(title: title, source: source))
  }

  @ViewBuilder private var subtitleText: some View {
    if let subtitle {
      Text(subtitle)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
  }

  private var removal: some View {
    let notice = Self.removalNotice(retainedAudio: retainedAudio)
    return VStack(alignment: .leading, spacing: 6) {
      Button("Remove from library", action: remove)
        .buttonStyle(.plain)
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
  }
}

/// A neutral row that discloses the way to change what it shows.
private struct DetailRow<Value: View>: View {
  let label: String
  var value: String?
  let action: () -> Void
  let identifier: String
  @ViewBuilder let content: () -> Value

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    Button(action: action) {
      // At the largest sizes the label, the value, and the disclosure cannot share a line, so
      // the value moves under the label rather than being squeezed out.
      Group {
        if typeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
              Text(label)
              Spacer()
              disclosure
            }
            valueText
            content()
          }
        } else {
          HStack(spacing: 8) {
            Text(label)
            Spacer()
            valueText.lineLimit(1)
            content()
            disclosure
          }
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .orbisRowHeight()
    .padding(.vertical, 10)
    .accessibilityIdentifier(identifier)
  }

  /// The value the row discloses. Its styling lives here so the two arrangements cannot drift.
  @ViewBuilder private var valueText: some View {
    if let value {
      Text(value)
        .foregroundStyle(.secondary)
    }
  }

  /// `chevron.forward`, not `chevron.right`: the disclosure points the way the language reads,
  /// and the system mirrors it in a right-to-left layout.
  private var disclosure: some View {
    Image(systemName: "chevron.forward")
      .font(.orbis.caption)
      .foregroundStyle(.tertiary)
  }
}

extension DetailRow where Value == EmptyView {
  init(label: String, value: String, action: @escaping () -> Void, identifier: String) {
    self.init(label: label, value: value, action: action, identifier: identifier) { EmptyView() }
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
      position: "42m in",
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

#Preview("Set detail, largest text, RTL, Mac") {
  SetDetailSample().orbisAccessibilityLayout()
}

#Preview("Set detail, largest text, RTL, iPhone") {
  SetDetailSample().frame(width: 390).orbisAccessibilityLayout()
}
