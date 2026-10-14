import SwiftUI

public struct PasteHero: View {
  @Binding public var link: String
  public let state: LinkFieldState
  public let compact: Bool
  public let hint: LocalizedStringKey
  /// Files the link the clipboard already holds, given the text it held. Absent on a screen that
  /// cannot file, and the button is absent with it.
  public let paste: ((String) -> Void)?
  public let pasteNotice: String?
  @Binding public var focusRequest: Bool
  public let file: () -> Void

  public init(
    link: Binding<String>, state: LinkFieldState = .idle, compact: Bool = false,
    hint: LocalizedStringKey = "Title and tags come next.",
    paste: ((String) -> Void)? = nil, pasteNotice: String? = nil,
    focusRequest: Binding<Bool> = .constant(false), file: @escaping () -> Void
  ) {
    _link = link
    self.state = state
    self.compact = compact
    self.hint = hint
    self.paste = paste
    self.pasteNotice = pasteNotice
    _focusRequest = focusRequest
    self.file = file
  }

  public var body: some View {
    VStack(alignment: .leading) {
      Text("Drop a link, file a set.")
        .font(.orbis.hero(compact: compact))
      LinkField(link: $link, state: state, focusRequest: $focusRequest, submit: file)
      if let paste {
        pasteButton(paste)
      }
      if let pasteNotice {
        Text(pasteNotice)
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("paste-notice")
      }
      Text(hint)
        .font(.orbis.detail)
        .foregroundStyle(.secondary)
    }
    .padding()
    .orbisRaised(radius: Radius.hero)
  }

  /// `PasteButton` rather than reading the pasteboard, because the system asks the person for
  /// permission before an app reads what they copied, and a button they press is the permission.
  private func pasteButton(_ paste: @escaping (String) -> Void) -> some View {
    #if os(tvOS)
      EmptyView()
    #else
      PasteButton(payloadType: String.self) { pasted in
        guard let text = pasted.first else { return }
        paste(text)
      }
      .labelStyle(.titleAndIcon)
      .controlSize(.extraLarge)
      .buttonBorderShape(.capsule)
      .buttonStyle(.bordered)
      .tint(Color.orbis.muted)
      .frame(maxWidth: .infinity)
      .accessibilityIdentifier("paste-and-file")
    #endif
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

private struct PasteHeroSample: View {
  @State private var link = "https://youtu.be/tPEMP9oYxTo"

  var body: some View {
    PasteHero(link: $link, state: .valid(source: "YouTube")) {}
  }
}

#Preview("Paste hero, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { PasteHeroSample() }
}

#Preview("Paste hero, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { PasteHeroSample() }
}
