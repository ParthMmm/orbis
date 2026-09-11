import SwiftUI

/// The first thing on the Library screen: paste a link, file a Set.
///
/// Content layer, so it sits on `paperRaised`, not glass. The one glass element is the
/// primary button — tinted, prominent, and the only tinted control on the screen.
public struct PasteHero: View {
  @Binding public var link: String
  public let compact: Bool
  public let hint: LocalizedStringKey
  public let file: () -> Void

  @FocusState private var focused: Bool

  public init(
    link: Binding<String>, compact: Bool = false,
    hint: LocalizedStringKey = "Title and tags come next.", file: @escaping () -> Void
  ) {
    _link = link
    self.compact = compact
    self.hint = hint
    self.file = file
  }

  public var body: some View {
    VStack(alignment: .leading) {
      Text("Drop a link, file a set.")
        .font(.orbis.hero(compact: compact))
      HStack {
        Image(systemName: "link")
          .foregroundStyle(.secondary)
        TextField("Paste a link", text: $link)
          .textFieldStyle(.plain)
          .focused($focused)
          .onSubmit(file)
          .autocorrectionDisabled()
          #if os(iOS)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          #endif
        Button("File it", action: file)
          .buttonStyle(.orbisPrimary)
          .disabled(link.isEmpty)
      }
      .padding(.leading)
      .padding(.vertical, 6)
      .padding(.trailing, 6)
      .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
      Text(hint)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
    .padding()
    .orbisRaised(radius: Radius.hero)
  }
}

#Preview("Paste hero") {
  @Previewable @State var link = ""
  VStack {
    PasteHero(link: $link) {}
    PasteHero(link: $link, compact: true, hint: "Or share to Orbis from YouTube or SoundCloud.") {}
      .frame(width: 358)
  }
  .padding()
  .background(Color.orbis.paper)
}
