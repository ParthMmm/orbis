import SwiftUI

/// One Playlist, chosen from the ones the library holds. A swatch, the name, and a disclosure,
/// because the row is a control: it opens the list rather than stating a fact.
///
/// The disclosure is the platform's own, which is why this is a `Menu` and not a sheet drawn
/// with a package radius. On a Mac it drops down, on a phone it rises, and neither shape is
/// something this package should decide.
public struct PlaylistPicker: View {
  /// A Playlist as a picker needs it: enough to draw the row, nothing about its Sets.
  public struct Choice: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let category: OrbisColor.Category

    public init(id: String, name: String, category: OrbisColor.Category) {
      self.id = id
      self.name = name
      self.category = category
    }
  }

  @Binding public var selection: String?
  public let choices: [Choice]
  public let category: @MainActor (String) -> OrbisColor.Category

  public init(
    selection: Binding<String?>, choices: [Choice],
    category: @escaping @MainActor (String) -> OrbisColor.Category = OrbisColor.Category.forTag
  ) {
    _selection = selection
    self.choices = choices
    self.category = category
  }

  private var current: Choice? {
    choices.first { $0.id == selection }
  }

  /// What the row is, read out in full. A person hearing only "Long drives" would not know
  /// whether it is the Playlist or a Tag.
  public static func label(for selection: String?, in choices: [Choice]) -> String {
    let name = choices.first { $0.id == selection }?.name
    return "Playlist, \(name ?? "none")"
  }

  public var body: some View {
    Menu {
      Button("No Playlist") { selection = nil }
      ForEach(choices) { choice in
        Button(choice.name) { selection = choice.id }
      }
    } label: {
      HStack(spacing: 8) {
        Circle()
          .fill(current.map { $0.category.dot } ?? Color.secondary)
          .frame(width: 9, height: 9)
        Text(current?.name ?? "No Playlist")
        Spacer()
        Image(systemName: "chevron.up.chevron.down")
          .font(.orbis.caption)
          .foregroundStyle(.secondary)
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .orbisRowHeight()
    .accessibilityLabel(Self.label(for: selection, in: choices))
  }
}

#Preview("Playlist picker") {
  @Previewable @State var chosen: String? = "1"
  @Previewable @State var none: String?
  VStack(alignment: .leading, spacing: 16) {
    PlaylistPicker(
      selection: $chosen,
      choices: [
        .init(id: "1", name: "Long drives", category: .cyan),
        .init(id: "2", name: "Closing sets", category: .purple),
      ]
    )
    PlaylistPicker(selection: $none, choices: [])
  }
  .padding()
  .background(Color.orbis.paper)
}

/// The picker in a row, at the sizes the matrix covers.
private struct PlaylistPickerSample: View {
  @State private var chosen: String? = "1"

  var body: some View {
    PlaylistPicker(
      selection: $chosen,
      choices: [
        .init(id: "1", name: "Long drives", category: .cyan),
        .init(id: "2", name: "Closing sets", category: .purple),
      ]
    )
    .padding()
  }
}

#Preview("Playlist picker, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { PlaylistPickerSample() }
}

#Preview("Playlist picker, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { PlaylistPickerSample() }
}
