import OrbisDesign
import SwiftUI

/// The signed-in Person's settings: their account, Downloads, and Devices, and for the Host the
/// Group Passcode and People (ADR 0020). A sheet from the gear on iOS, the Settings window on
/// the Mac.
struct SettingsView: View {
  let model: AppModel
  @State private var me: Loadable<Me> = .idle
  /// The key `me` was loaded with. Settings reappears after a pushed Person page, and reloading
  /// then would drop the code on screen.
  @State private var loadedToken: String?
  @State private var username = ""
  @State private var code: SignInCode?
  @State private var failure: OrbisFailure?
  @State private var codeFailure: OrbisFailure?
  @State private var isSaving = false
  @State private var isConfirmingSignOut = false

  var body: some View {
    Group {
      if model.isConfigured {
        form
      } else {
        ContentUnavailableView(
          "Not Signed In", systemImage: "person.crop.circle",
          description: Text("Sign in to Orbis in its window first."))
      }
    }
    .navigationTitle("Settings")
    // Keyed on the key, so signing in as someone else reloads the Person this window shows.
    .task(id: model.client?.token) { await load() }
  }

  private var form: some View {
    Form {
      switch me {
      case .idle, .loading:
        Section { ProgressView() }
      case .failed(let failure):
        Section {
          FailureRows(failure: failure, context: "loading settings", identifier: "settings-load-error")
          Button("Try Again") {
            loadedToken = nil
            Task { await load() }
          }
        }
      case .loaded(let person):
        account(person)
        downloads(person)
      }
      devices
      if case .loaded(let person) = me, person.host {
        HostSections(model: model, hostId: person.id)
      }
      Section {
      } footer: {
        Text("Orbis \(FailureReport.appVersion)")
          .frame(maxWidth: .infinity)
          .accessibilityIdentifier("settings-version")
      }
    }
    .formStyle(.grouped)
    .font(.orbis.body)
    .confirmationDialog(
      "Sign out of Orbis?", isPresented: $isConfirmingSignOut, titleVisibility: .visible
    ) {
      Button("Sign Out", role: .destructive) { model.signOut() }
        .accessibilityIdentifier("settings-sign-out-confirm")
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("To sign in again, you need a Sign-in Code from another device or from your Host.")
    }
  }

  private func account(_ person: Me) -> some View {
    Section {
      HStack {
        TextField("Username", text: $username)
          .plainEntry()
          .onSubmit { saveUsername(person) }
          .accessibilityIdentifier("settings-username")
        if trimmedUsername != person.username, !trimmedUsername.isEmpty {
          Button("Save") { saveUsername(person) }
            .disabled(isSaving)
            .accessibilityIdentifier("settings-username-save")
        }
      }
      Toggle("Social", isOn: setting(person.social) { MeUpdate(social: $0) })
        .disabled(isSaving)
        .accessibilityIdentifier("settings-social")
      FailureRows(failure: failure, context: "changing settings", identifier: "settings-error")
    } header: {
      Text("Account")
    } footer: {
      Text("With Social on, People in your Group see your Sets, Playlists, and listening, and you see theirs.")
    }
  }

  private func downloads(_ person: Me) -> some View {
    Section {
      Toggle("Auto Download", isOn: setting(person.autoDownload) { MeUpdate(autoDownload: $0) })
        .disabled(isSaving)
        .accessibilityIdentifier("auto-download")
    } header: {
      Text("Downloads")
    } footer: {
      Text("Download audio on your Orbis service when you save a Set. This applies to all your devices.")
    }
  }

  private var devices: some View {
    Section {
      if let code {
        SignInCodeView(code: code, identifier: "settings-sign-in-code")
        Button("New Code") { Task { await makeCode() } }
          .accessibilityIdentifier("settings-sign-in-code-new")
      } else {
        Button("Sign in another device") { Task { await makeCode() } }
          .accessibilityIdentifier("settings-sign-in-another")
      }
      FailureRows(
        failure: codeFailure, context: "making a Sign-in Code", identifier: "settings-code-error")
      Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
        .accessibilityIdentifier("settings-sign-out")
    } header: {
      Text("Devices")
    } footer: {
      if code != nil {
        Text("On the new device, choose I have a code and type this.")
      }
    }
  }

  private var trimmedUsername: String {
    username.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// A toggle that sends its change to `/me` and shows what the service stored.
  private func setting(_ value: Bool, _ update: @escaping (Bool) -> MeUpdate) -> Binding<Bool> {
    Binding(get: { value }, set: { enabled in Task { await save(update(enabled)) } })
  }

  private func load() async {
    guard let token = model.client?.token, token != loadedToken else { return }
    loadedToken = token
    code = nil
    me = .loading
    let person = await settingsRequest(
      model, { if let loadFailure = $0 { me = .failed(loadFailure) } }, { try await $0.me() })
    if let person {
      me = .loaded(person)
      username = person.username
    }
  }

  private func saveUsername(_ person: Me) {
    guard trimmedUsername != person.username, !trimmedUsername.isEmpty else { return }
    Task { await save(MeUpdate(username: trimmedUsername)) }
  }

  private func save(_ update: MeUpdate) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    if let person = await settingsRequest(model, { failure = $0 }, { try await $0.updateMe(update) }) {
      me = .loaded(person)
      username = person.username
    }
  }

  private func makeCode() async {
    code = await settingsRequest(model, { codeFailure = $0 }, { try await $0.signInCode() }) ?? code
  }
}

/// Runs one Settings request against the signed-in client. `report` hears nil as the request
/// starts and the failure if it fails; a request the screen abandoned says nothing.
@MainActor
private func settingsRequest<T>(
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
private struct SignInCodeView: View {
  let code: SignInCode
  let identifier: String

  var body: some View {
    VStack(spacing: 6) {
      Text(code.formatted)
        .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
        .textSelection(.enabled)
        .accessibilityIdentifier(identifier)
      Text("Works once, until \(SetPresentation.DateParsing.date(from: code.expiresAt), style: .time).")
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.muted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }
}

private struct HostSections: View {
  let model: AppModel
  let hostId: String
  @State private var isLoaded = false
  @State private var passcode: String?
  @State private var draft = ""
  @State private var people: Loadable<[GroupPerson]> = .idle
  @State private var failure: OrbisFailure?
  @State private var isSaving = false

  var body: some View {
    Section {
      TextField("Group Passcode", text: $draft)
        .plainEntry()
        .onSubmit { Task { await save(trimmedDraft) } }
        .accessibilityIdentifier("settings-passcode")
      Button(passcode == nil ? "Open Joining" : "Change Passcode") {
        Task { await save(trimmedDraft) }
      }
      .disabled(trimmedDraft.isEmpty || trimmedDraft == passcode || isSaving)
      .accessibilityIdentifier("settings-passcode-save")
      if passcode != nil {
        Button("Close Joining", role: .destructive) { Task { await save(nil) } }
          .disabled(isSaving)
          .accessibilityIdentifier("settings-passcode-clear")
      }
      FailureRows(failure: failure, context: "managing the Group", identifier: "settings-host-error")
    } header: {
      Text("Group Passcode")
    } footer: {
      Text(
        passcode == nil
          ? "Joining is closed. Set a passcode and tell it to a friend so they can join."
          : "Friends type this to join. Changing it does not sign anyone out."
      )
      .accessibilityIdentifier("settings-passcode-state")
    }
    // A modifier on a section reaches each of its rows, so this runs once per row; the flag
    // keeps it to one load.
    .task {
      guard !isLoaded else { return }
      isLoaded = true
      await loadPasscode()
      await loadPeople()
    }

    Section("People") {
      switch people {
      case .idle, .loading:
        ProgressView()
      case .failed(let failure):
        FailureRows(failure: failure, context: "loading People", identifier: "settings-people-error")
        Button("Try Again") { Task { await loadPeople() } }
      case .loaded(let people):
        ForEach(people) { person in
          NavigationLink {
            PersonView(model: model, person: person, isSelf: person.id == hostId) {
              Task { await loadPeople() }
            }
          } label: {
            Text(person.id == hostId ? "\(person.username) (you)" : person.username)
          }
          .accessibilityIdentifier("person-\(person.username)")
        }
      }
    }
  }

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func loadPasscode() async {
    if let current = await settingsRequest(model, { failure = $0 }, { try await $0.passcode() }) {
      passcode = current
      draft = current ?? ""
    }
  }

  private func loadPeople() async {
    if case .loaded = people {} else { people = .loading }
    let list = await settingsRequest(
      model, { if let peopleFailure = $0 { people = .failed(peopleFailure) } },
      { try await $0.people() })
    if let list { people = .loaded(list) }
  }

  private func save(_ next: String?) async {
    guard !isSaving, next == nil || next?.isEmpty == false else { return }
    isSaving = true
    defer { isSaving = false }
    if let stored = await settingsRequest(model, { failure = $0 }, { try await $0.setPasscode(next) }) {
      passcode = stored
      draft = stored ?? ""
    }
  }
}

/// One Person, as the Host sees them: a Sign-in Code for a new device, and removal.
private struct PersonView: View {
  let model: AppModel
  let person: GroupPerson
  /// The Host's own row, which can show a code but not remove itself.
  let isSelf: Bool
  let removed: () -> Void
  @State private var code: SignInCode?
  @State private var failure: OrbisFailure?
  @State private var isConfirmingRemoval = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        if let code {
          SignInCodeView(code: code, identifier: "person-sign-in-code")
        }
        Button(code == nil ? "Show Sign-in Code" : "New Code") { Task { await makeCode() } }
          .accessibilityIdentifier("person-show-code")
        FailureRows(failure: failure, context: "managing a Person", identifier: "person-error")
      } footer: {
        Text("On \(isSelf ? "your" : "their") new device, choose I have a code and type this.")
      }
      if !isSelf {
        Section {
          Button("Remove \(person.username)", role: .destructive) { isConfirmingRemoval = true }
            .accessibilityIdentifier("person-remove")
        } footer: {
          Text("They leave the Group and are signed out on every device.")
        }
      }
    }
    .formStyle(.grouped)
    .font(.orbis.body)
    .navigationTitle(person.username)
    .confirmationDialog(
      "Remove \(person.username)?", isPresented: $isConfirmingRemoval, titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) { Task { await remove() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("They leave the Group and are signed out on every device.")
    }
  }

  private func makeCode() async {
    let id = person.id
    code = await settingsRequest(model, { failure = $0 }, { try await $0.signInCode(for: id) }) ?? code
  }

  private func remove() async {
    let id = person.id
    guard await settingsRequest(model, { failure = $0 }, { try await $0.removePerson(id) }) != nil
    else { return }
    removed()
    dismiss()
  }
}
