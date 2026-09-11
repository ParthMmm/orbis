import SwiftUI

/// The first thing on the Library screen: paste a link, file a Set.
///
/// Content layer, so it sits on `paperRaised`, not glass. The one glass element is the
/// primary button — tinted, prominent, and the only tinted control on the screen.
public struct PasteHero: View {
  @Binding public var link: String
  public let state: LinkFieldState
  public let compact: Bool
  public let hint: LocalizedStringKey
  public let file: () -> Void

  public init(
    link: Binding<String>, state: LinkFieldState = .idle, compact: Bool = false,
    hint: LocalizedStringKey = "Title and tags come next.", file: @escaping () -> Void
  ) {
    _link = link
    self.state = state
    self.compact = compact
    self.hint = hint
    self.file = file
  }

  public var body: some View {
    VStack(alignment: .leading) {
      Text("Drop a link, file a set.")
        .font(.orbis.hero(compact: compact))
      LinkField(link: $link, state: state, submit: file)
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
  @Previewable @State var pasted = "https://youtu.be/tPEMP9oYxTo"
  VStack {
    PasteHero(link: $link) {}
    PasteHero(link: $pasted, state: .valid(source: "YouTube")) {}
    PasteHero(link: $link, compact: true, hint: "Or share to Orbis from YouTube or SoundCloud.") {}
      .frame(width: 358)
  }
  .padding()
  .background(Color.orbis.paper)
}
