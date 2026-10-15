import OrbisDesign
import SwiftUI

/// What Settings shows and the requests that change it (ADR 0020).
@MainActor
@Observable
final class SettingsModel {
  private let app: AppModel
  var me: Loadable<Me> = .idle
  /// The Group Passcode, nil while joining is closed. Host only.
  var passcode: String?
  /// What the username field holds, kept here so a pushed Person page coming back does not reset
  /// it.
  var username = ""
  var people: Loadable<[GroupPerson]> = .idle
  var code: SignInCode?
  var accountFailure: OrbisFailure?
  var groupFailure: OrbisFailure?
  var downloadsFailure: OrbisFailure?
  var codeFailure: OrbisFailure?
  var hostFailure: OrbisFailure?
  var isSaving = false
  private var loadedToken: String?

  init(app: AppModel) {
    self.app = app
  }

  func load() async {
    guard app.isConfigured else { return }
    if loadedToken != app.client?.token {
      loadedToken = app.client?.token
      forgetPerson()
    }
    code = nil
    if case .loaded = me {} else { me = .loading }
    guard
      let person = await settingsRequest(
        app, { if let failure = $0 { self.me = .failed(failure) } }, { try await $0.me() })
    else { return }
    me = .loaded(person)
    username = person.username
    guard person.host else { return }
    async let passcodeLoad: Void = loadPasscode()
    async let peopleLoad: Void = loadPeople()
    _ = await (passcodeLoad, peopleLoad)
  }

  private func forgetPerson() {
    me = .idle
    passcode = nil
    username = ""
    people = .idle
    accountFailure = nil
    groupFailure = nil
    downloadsFailure = nil
    codeFailure = nil
    hostFailure = nil
  }

  func loadPasscode() async {
    if let current = await settingsRequest(app, { self.hostFailure = $0 }, { try await $0.passcode() }) {
      passcode = current
    }
  }

  func loadPeople() async {
    if case .loaded = people {} else { people = .loading }
    let list = await settingsRequest(
      app, { if let failure = $0 { self.people = .failed(failure) } }, { try await $0.people() })
    if let list { people = .loaded(list) }
  }

  /// Sends a change to `/me`; a failure is said in the section the change came from.
  func save(_ update: MeUpdate, failure: ReferenceWritableKeyPath<SettingsModel, OrbisFailure?>) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    if let person = await settingsRequest(app, { self[keyPath: failure] = $0 }, { try await $0.updateMe(update) }) {
      me = .loaded(person)
      username = person.username
    }
  }

  func makeCode() async {
    code = await settingsRequest(app, { self.codeFailure = $0 }, { try await $0.signInCode() }) ?? code
  }

  /// Opens joining with a new random passcode, or closes it.
  func changeJoining(open: Bool) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    let stored = await settingsRequest(
      app, { self.hostFailure = $0 },
      { open ? try await $0.newPasscode() : try await $0.closeJoining() })
    if let stored { passcode = stored }
  }
}

/// Runs one Settings request against the signed-in client. `report` hears nil as the request
/// starts and the failure if it fails; a request the screen abandoned says nothing.
@MainActor
func settingsRequest<T>(
  _ model: AppModel, _ report: (OrbisFailure?) -> Void, _ work: (OrbisClient) async throws -> T
) async -> T? {
  guard let client = model.client else { return nil }
  report(nil)
  do {
    return try await work(client)
  } catch OrbisError.cancelled {
    return nil
  } catch {
    report(.explaining(error, at: client.address))
    return nil
  }
}

/// A failure's sentence and the way to copy its details, as rows of the section that failed.
struct FailureRows: View {
  let failure: OrbisFailure?
  let context: String
  let identifier: String

  var body: some View {
    if let failure {
      Text(failure.message)
        .foregroundStyle(OrbisColor.destructive)
        .accessibilityIdentifier(identifier)
      CopyFailureButton(report: FailureReport(failure: failure, context: context))
    }
  }
}

/// A Sign-in Code, large enough to read across a room, with when it stops working.
struct SignInCodeView: View {
  let code: SignInCode
  let identifier: String

  var body: some View {
    VStack(spacing: 6) {
      HStack(spacing: 12) {
        Text(code.formatted)
          .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
          #if !os(tvOS)
            .textSelection(.enabled)
          #endif
          .accessibilityIdentifier(identifier)
        #if !os(tvOS)
          CopyButton(title: "Copy Code", text: code.code, identifier: "\(identifier)-copy")
            .font(.title3)
        #endif
      }
      Text("Works once, until \(SetPresentation.date(from: code.expiresAt), style: .time).")
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.muted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }
}

/// A copy symbol that puts `text` on the clipboard and turns into a checkmark for a moment. The
/// title is what VoiceOver reads; the text itself never shows. With a `row` name, the whole row
/// is the button, so tapping the name copies too.
struct CopyButton: View {
  let title: String
  let text: String
  let identifier: String
  var row: String?
  @State private var copied = false

  var body: some View {
    Button {
      copyToPasteboard(text)
      copied = true
    } label: {
      if let row {
        LabeledContent {
          symbol
        } label: {
          Text(row).foregroundStyle(Color.primary)
        }
      } else {
        // The symbol alone is smaller than a finger, so its tap area is the 44-point minimum.
        symbol
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(copied ? "Copied" : title)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
    .task(id: copied) {
      guard copied else { return }
      try? await Task.sleep(for: .seconds(2))
      copied = false
    }
    .accessibilityIdentifier(identifier)
  }

  /// Sized by the copy symbol, the wider of the two, so the checkmark does not move what sits
  /// beside it.
  private var symbol: some View {
    Image(systemName: "doc.on.doc")
      .hidden()
      .overlay {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .foregroundStyle(Color.orbis.tint)
          .contentTransition(.symbolEffect(.replace))
      }
  }
}
