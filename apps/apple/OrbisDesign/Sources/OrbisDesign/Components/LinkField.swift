import Accessibility
import SwiftUI

/// What the field is showing about the pasted Source Link.
///
/// One value drives every state, so the field cannot render a spinner over a failure or a
/// stamp over a link that was refused. The service decides what a link is worth, so only
/// `idle` and `checking` are reached without asking it.
public enum LinkFieldState: Equatable, Sendable {
  case idle
  case checking
  case valid(source: String)
  case invalid(message: String)
  case duplicate(message: String)

  /// The line under the field. Only the two refusals have words to show; the rest speak
  /// through the field itself.
  public var message: String? {
    switch self {
    case let .invalid(message), let .duplicate(message): message
    case .idle, .checking, .valid: nil
    }
  }

  var symbol: String {
    switch self {
    case .checking: "ellipsis"
    case .invalid: "exclamationmark.triangle"
    case .duplicate: "square.on.square"
    case .idle, .valid: "link"
    }
  }
}

/// The link field: paste a Source Link, file it, and read back what the service made of it.
///
/// Content layer, so the field sits on `field` and the button is the one tinted control.
/// A refusal is told with a symbol and a sentence, never with color, because the palette
/// gives red to removal and this is not a removal.
public struct LinkField: View {
  @Binding public var link: String
  public let state: LinkFieldState
  public let action: LocalizedStringKey
  public let submit: () -> Void

  @FocusState private var focused: Bool

  public init(
    link: Binding<String>, state: LinkFieldState = .idle,
    action: LocalizedStringKey = "File it", submit: @escaping () -> Void
  ) {
    _link = link
    self.state = state
    self.action = action
    self.submit = submit
  }

  /// A link can be filed once it is shaped like one. Whether Orbis supports it is the
  /// service's judgement, and comes back as `.invalid`.
  public static func canSubmit(link: String, state: LinkFieldState) -> Bool {
    guard state != .checking else { return false }
    guard let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = url.host(), !host.isEmpty
    else { return false }
    return true
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Group {
          if state == .checking {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: state.symbol).foregroundStyle(.secondary)
          }
        }
        .frame(width: 16)
        TextField("Paste a link", text: $link)
          .textFieldStyle(.plain)
          .focused($focused)
          .onSubmit(submit)
          .autocorrectionDisabled()
          #if os(iOS)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          #endif
        if case let .valid(source) = state {
          SourceStamp(source)
        }
        Button(action, action: submit)
          .buttonStyle(.orbisPrimary)
          .disabled(!Self.canSubmit(link: link, state: state))
      }
      .padding(.leading)
      .padding(.vertical, 6)
      .padding(.trailing, 6)
      .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
      if let message = state.message {
        Label(message, systemImage: state.symbol)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
    }
    .onChange(of: state) { _, state in
      guard let message = state.message else { return }
      AccessibilityNotification.Announcement(message).post()
    }
  }
}

private struct LinkFieldStates: View {
  @State private var typed = "https://youtu.be/tPEMP9oYxTo"
  @State private var bad = "https://example.com/set"
  @State private var empty = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      LinkField(link: $empty, submit: {})
      LinkField(link: $typed, state: .checking, submit: {})
      LinkField(link: $typed, state: .valid(source: "YouTube"), submit: {})
      LinkField(
        link: $bad, state: .invalid(message: "Orbis does not know that address."), submit: {})
      LinkField(
        link: $bad, state: .duplicate(message: "That set is already in your library."), submit: {})
    }
    .padding()
    .background(Color.orbis.paper)
  }
}

#Preview("Link field, Mac") { LinkFieldStates() }

#Preview("Link field, Mac, dark") { LinkFieldStates().preferredColorScheme(.dark) }

#Preview("Link field, iPhone") { LinkFieldStates().frame(width: 358) }

#Preview("Link field, iPhone, dark") {
  LinkFieldStates().frame(width: 358).preferredColorScheme(.dark)
}
