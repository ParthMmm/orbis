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
  /// Files the link the clipboard already holds, given the text it held. Absent on a screen that
  /// cannot file, and the button is absent with it.
  public let paste: ((String) -> Void)?
  /// What the last paste had to say when the clipboard held nothing worth filing, said here rather
  /// than written into the field, because the field is the person's.
  public let pasteNotice: String?
  public let file: () -> Void

  public init(
    link: Binding<String>, state: LinkFieldState = .idle, compact: Bool = false,
    hint: LocalizedStringKey = "Title and tags come next.",
    paste: ((String) -> Void)? = nil, pasteNotice: String? = nil, file: @escaping () -> Void
  ) {
    _link = link
    self.state = state
    self.compact = compact
    self.hint = hint
    self.paste = paste
    self.pasteNotice = pasteNotice
    self.file = file
  }

  public var body: some View {
    VStack(alignment: .leading) {
      Text("Drop a link, file a set.")
        .font(.orbis.hero(compact: compact))
      LinkField(link: $link, state: state, submit: file)
      if let paste {
        pasteButton(paste)
      }
      if let pasteNotice {
        Text(pasteNotice)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("paste-notice")
      }
      Text(hint)
        .font(.orbis.mono)
        .foregroundStyle(.secondary)
    }
    .padding()
    .orbisRaised(radius: Radius.hero)
  }

  /// The one-tap path for a link that is already on the clipboard.
  ///
  /// `PasteButton` rather than reading the pasteboard, because the system asks the person for
  /// permission before an app reads what they copied, and a button they press is the permission.
  /// Neutral rather than tinted: the tinted control in this hero stays the one that files what the
  /// person typed.
  private func pasteButton(_ paste: @escaping (String) -> Void) -> some View {
    // `PasteButton` draws its own title and takes no label, which is the price of the system
    // asking the person for permission instead of the app reading the pasteboard behind their back.
    PasteButton(payloadType: String.self) { pasted in
      guard let text = pasted.first else { return }
      paste(text)
    }
    .labelStyle(.titleAndIcon)
    .controlSize(.extraLarge)
    .buttonBorderShape(.capsule)
    .buttonStyle(.bordered)
    // The system draws this button in the accent colour. Orbis gives tint to the one action a
    // screen is for, which in this hero is the button that files what was typed, so the paste
    // shortcut is drawn in the muted ink instead.
    .tint(Color.orbis.muted)
    .frame(maxWidth: .infinity)
    .accessibilityIdentifier("paste-and-file")
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
    PasteHero(
      link: $link, paste: { _ in },
      pasteNotice: "The clipboard holds no YouTube or SoundCloud link."
    ) {}
    .frame(width: 358)
  }
  .padding()
  .background(Color.orbis.paper)
}
