import OrbisDesign
import SwiftUI

@MainActor
@Observable
final class SettingsModel {
  private let app: AppModel
  var me: Loadable<Me> = .idle
  var passcode: String?
  var username = ""
  var passcodeDraft = ""
  var people: Loadable<[GroupPerson]> = .idle
  var code: SignInCode?
  var accountFailure: OrbisFailure?
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
    passcodeDraft = ""
    people = .idle
    accountFailure = nil
    downloadsFailure = nil
    codeFailure = nil
    hostFailure = nil
  }

  func loadPasscode() async {
    if let current = await settingsRequest(app, { self.hostFailure = $0 }, { try await $0.passcode() }) {
      passcode = current
      passcodeDraft = current ?? ""
    }
  }

  func loadPeople() async {
    if case .loaded = people {} else { people = .loading }
    let list = await settingsRequest(
      app, { if let failure = $0 { self.people = .failed(failure) } }, { try await $0.people() })
    if let list { people = .loaded(list) }
  }

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

  func setPasscode(_ next: String?) async {
    guard !isSaving, next == nil || next?.isEmpty == false else { return }
    isSaving = true
    defer { isSaving = false }
    if let stored = await settingsRequest(app, { self.hostFailure = $0 }, { try await $0.setPasscode(next) }) {
      passcode = stored
      passcodeDraft = stored ?? ""
    }
  }
}

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

struct SignInCodeView: View {
  let code: SignInCode
  let identifier: String

  var body: some View {
    VStack(spacing: 6) {
      Text(code.formatted)
        .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
        #if !os(tvOS)
          .textSelection(.enabled)
        #endif
        .accessibilityIdentifier(identifier)
      Text("Works once, until \(SetPresentation.date(from: code.expiresAt), style: .time).")
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.muted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }
}
