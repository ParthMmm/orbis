import Foundation
import Observation
import OrbisDesign

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
  /// The Sign-in Code made on another Person's page and what last failed there, by Person, so
  /// one Person's page never shows another's.
  private(set) var personCodes: [String: SignInCode] = [:]
  private(set) var personFailures: [String: OrbisFailure] = [:]
  var isSaving = false
  /// Where Allow Joining was switched to while the service has not answered yet.
  private var joiningRequested: Bool?
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
    personCodes = [:]
    personFailures = [:]
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

  /// Sends a change to `/me` and answers whether the service took it. The change shows at once,
  /// so a switch moves when it is pressed; a refusal puts the stored value back and is said in
  /// the section the change came from.
  @discardableResult
  func save(_ update: MeUpdate, failure: ReferenceWritableKeyPath<SettingsModel, OrbisFailure?>) async -> Bool {
    guard !isSaving, case .loaded(let stored) = me else { return false }
    isSaving = true
    defer { isSaving = false }
    let shown = stored.applying(update)
    me = .loaded(shown)
    guard
      let person = await settingsRequest(app, { self[keyPath: failure] = $0 }, { try await $0.updateMe(update) })
    else {
      if me == .loaded(shown) { me = .loaded(stored) }
      return false
    }
    me = .loaded(person)
    username = person.username
    return true
  }

  func makeCode() async {
    code = await settingsRequest(app, { self.codeFailure = $0 }, { try await $0.signInCode() }) ?? code
  }

  /// Whether Allow Joining shows as on: where it was switched to while the service answers, and
  /// whether the Group has a passcode otherwise, so a refusal puts the switch back.
  var isJoiningOpen: Bool { joiningRequested ?? (passcode != nil) }

  /// Opens joining with a new random passcode, or closes it.
  func changeJoining(open: Bool) async {
    guard !isSaving else { return }
    isSaving = true
    joiningRequested = open
    defer {
      isSaving = false
      joiningRequested = nil
    }
    let stored = await settingsRequest(
      app, { self.hostFailure = $0 },
      { open ? try await $0.newPasscode() : try await $0.closeJoining() })
    if let stored { passcode = stored }
  }

  func makeCode(for personId: String) async {
    if let code = await settingsRequest(
      app, { self.personFailures[personId] = $0 }, { try await $0.signInCode(for: personId) })
    {
      personCodes[personId] = code
    }
  }

  /// Removes a Person from the Group and answers whether the service did.
  func remove(_ personId: String) async -> Bool {
    guard
      await settingsRequest(
        app, { self.personFailures[personId] = $0 }, { try await $0.removePerson(personId) }) != nil
    else { return false }
    personCodes[personId] = nil
    if case .loaded(let list) = people {
      people = .loaded(list.filter { $0.id != personId })
    }
    return true
  }
}

extension Me {
  fileprivate func applying(_ update: MeUpdate) -> Me {
    Me(
      autoDownload: update.autoDownload ?? autoDownload, host: host, id: id,
      social: update.social ?? social, username: update.username ?? username)
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
