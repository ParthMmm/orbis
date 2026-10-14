import Accessibility
import SwiftUI

public enum LinkFieldState: Equatable, Sendable {
  case idle
  case checking
  case valid(source: String)
  case invalid(message: String)
  case duplicate(message: String)

  public var message: String? {
    switch self {
    case .invalid(let message), .duplicate(let message): message
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

public struct LinkField: View {
  @Binding public var link: String
  public let state: LinkFieldState
  public let action: LocalizedStringKey
  /// A caller that wants the field focused sets this. The field clears it once focus is taken,
  /// so asking again is another change rather than a no-op.
  @Binding public var focusRequest: Bool
  public let submit: () -> Void

  @Environment(\.dynamicTypeSize) private var typeSize
  @FocusState private var focused: Bool

  @State private var accepted = 0
  @State private var refused = 0

  public init(
    link: Binding<String>, state: LinkFieldState = .idle,
    action: LocalizedStringKey = "File it", focusRequest: Binding<Bool> = .constant(false),
    submit: @escaping () -> Void
  ) {
    _link = link
    self.state = state
    self.action = action
    _focusRequest = focusRequest
    self.submit = submit
  }

  public static func canSubmit(link: String, state: LinkFieldState) -> Bool {
    guard state != .checking else { return false }
    return address(of: link) != nil
  }

  private var field: some View {
    HStack {
      ZStack {
        Image(systemName: state.symbol)
          .foregroundStyle(.secondary)
          .opacity(state == .checking ? 0 : 1)
          .orbisSymbolEffect(.filingSucceeded, trigger: accepted)
          .orbisSymbolEffect(.filingFailed, trigger: refused)
        if state == .checking {
          ProgressView().controlSize(.small)
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
      if case .valid(let source) = state {
        SourceStamp(source)
      }
    }
  }

  private var submitButton: some View {
    Button(action, action: submit)
      .buttonStyle(.orbisPrimary)
      .disabled(!Self.canSubmit(link: link, state: state))
  }

  public nonisolated static func address(of text: String) -> URL? {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = url.host(), !host.isEmpty
    else { return nil }
    return url
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 6) {
          field
            .padding(.horizontal)
            .padding(.vertical, 6)
            .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
          submitButton.frame(maxWidth: .infinity, alignment: .trailing)
        }
      } else {
        HStack {
          field
          submitButton
        }
        .padding(.leading)
        .padding(.vertical, 6)
        .padding(.trailing, 6)
        .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
      }
      if let message = state.message {
        Label(message, systemImage: state.symbol)
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
      }
    }
    .onChange(of: state) { _, state in
      switch state {
      case .valid: accepted += 1
      case .invalid, .duplicate: refused += 1
      case .idle, .checking: break
      }
      guard let message = state.message else { return }
      AccessibilityNotification.Announcement(message).post()
    }
    .onChange(of: focusRequest) { _, wantsFocus in
      guard wantsFocus else { return }
      focused = true
      focusRequest = false
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

#Preview("Link field, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) { LinkFieldStates() }
}

#Preview("Link field, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) { LinkFieldStates() }
}

private struct FilingOutcomes: View {
  @State private var link = "https://youtu.be/tPEMP9oYxTo"
  @State private var state: LinkFieldState = .idle

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      LinkField(link: $link, state: state, submit: {})
      HStack {
        Button("Accept") { state = .valid(source: "YouTube") }
        Button("Refuse") { state = .invalid(message: "Orbis does not know that address.") }
        Button("Reset") { state = .idle }
      }
      .buttonStyle(.bordered)
    }
    .padding()
    .background(Color.orbis.paper)
  }
}

#Preview("Filing outcomes") { FilingOutcomes() }

#Preview("Filing outcomes, Reduce Motion") {
  FilingOutcomes().orbisReduceMotion(true)
}
