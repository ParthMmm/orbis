import OrbisDesign
import SwiftUI

/// Settings with its navigation stack: a sheet from the gear on iOS, the Settings window on the
/// Mac. The data loads here, above the stack, so a pushed Person page coming back does not
/// reload it.
struct SettingsScreen: View {
  let model: AppModel
  var done: (() -> Void)?
  @State private var settings: SettingsModel

  init(model: AppModel, done: (() -> Void)? = nil) {
    self.model = model
    self.done = done
    _settings = State(initialValue: SettingsModel(app: model))
  }

  var body: some View {
    NavigationStack {
      SettingsView(model: model, settings: settings)
        .toolbar {
          if let done {
            ToolbarItem(placement: .confirmationAction) {
              Button("Done", action: done)
                .accessibilityIdentifier("settings-done")
            }
          }
        }
    }
    // Keyed on the key, so signing in as someone else reloads the Person this shows.
    .task(id: model.client?.token) { await settings.load() }
  }
}

/// The signed-in Person's settings: their account, Downloads, and Devices, and for the Host the
/// Group Passcode and People.
struct SettingsView: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
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
  }

  private var form: some View {
    Form {
      switch settings.me {
      case .idle, .loading:
        Section { ProgressView() }
      case .failed(let failure):
        Section {
          FailureRows(failure: failure, context: "loading settings", identifier: "settings-load-error")
          Button("Try Again") { Task { await settings.load() } }
        }
      case .loaded(let person):
        account(person)
        downloads(person)
      }
      library
      devices
      if case .loaded(let person) = settings.me, person.host {
        HostSections(model: model, settings: settings, hostId: person.id)
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
    .scrollContentBackground(.hidden)
    .background { TintGlow() }
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
        TextField("Username", text: $settings.username)
          .plainEntry()
          .onSubmit { saveUsername(person) }
          .accessibilityIdentifier("settings-username")
        if trimmedUsername != person.username, !trimmedUsername.isEmpty {
          Button("Save") { saveUsername(person) }
            .disabled(settings.isSaving)
            .accessibilityIdentifier("settings-username-save")
        }
      }
      Toggle("Social", isOn: setting(person.social, failure: \.accountFailure) { MeUpdate(social: $0) })
        .disabled(settings.isSaving)
        .accessibilityIdentifier("settings-social")
      FailureRows(failure: settings.accountFailure, context: "changing settings", identifier: "settings-error")
    } header: {
      Text("Account")
    } footer: {
      Text("With Social on, People in your Group see your Sets, Playlists, and listening, and you see theirs.")
    }
  }

  private func downloads(_ person: Me) -> some View {
    Section {
      Toggle(
        "Auto Download",
        isOn: setting(person.autoDownload, failure: \.downloadsFailure) { MeUpdate(autoDownload: $0) }
      )
      .disabled(settings.isSaving)
      .accessibilityIdentifier("auto-download")
      FailureRows(
        failure: settings.downloadsFailure, context: "changing Auto Download",
        identifier: "auto-download-error")
    } header: {
      Text("Downloads")
    } footer: {
      Text("Download audio on your Orbis service when you save a Set. This applies to all your devices.")
    }
  }

  private var library: some View {
    Section("Library") {
      LabeledContent("Audio kept", value: keptCount == 1 ? "1 set" : "\(keptCount) sets")
      LabeledContent("Tags", value: model.availableTags.count, format: .number)
    }
  }

  private var keptCount: Int {
    guard case .loaded(let sets) = model.library else { return 0 }
    return sets.filter { $0.downloadState == "ready" }.count
  }

  private var devices: some View {
    Section {
      if let code = settings.code {
        SignInCodeView(code: code, identifier: "settings-sign-in-code")
        Button("New Code") { Task { await settings.makeCode() } }
          .accessibilityIdentifier("settings-sign-in-code-new")
      } else {
        Button("Sign in another device") { Task { await settings.makeCode() } }
          .accessibilityIdentifier("settings-sign-in-another")
      }
      FailureRows(
        failure: settings.codeFailure, context: "making a Sign-in Code",
        identifier: "settings-code-error")
      Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
        .accessibilityIdentifier("settings-sign-out")
    } header: {
      Text("Devices")
    } footer: {
      if settings.code != nil {
        Text("On the new device, choose I Have a Code and type this.")
      }
    }
  }

  private var trimmedUsername: String {
    settings.username.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func setting(
    _ value: Bool, failure: ReferenceWritableKeyPath<SettingsModel, OrbisFailure?>,
    _ update: @escaping (Bool) -> MeUpdate
  ) -> Binding<Bool> {
    Binding(
      get: { value },
      set: { enabled in Task { await settings.save(update(enabled), failure: failure) } })
  }

  private func saveUsername(_ person: Me) {
    guard trimmedUsername != person.username, !trimmedUsername.isEmpty else { return }
    let username = trimmedUsername
    Task { await settings.save(MeUpdate(username: username), failure: \.accountFailure) }
  }
}

private struct HostSections: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
  let hostId: String

  var body: some View {
    Section {
      TextField("Group Passcode", text: $settings.passcodeDraft)
        .plainEntry()
        .onSubmit { Task { await settings.setPasscode(trimmedDraft) } }
        .accessibilityIdentifier("settings-passcode")
      Button(settings.passcode == nil ? "Open Joining" : "Change Passcode") {
        Task { await settings.setPasscode(trimmedDraft) }
      }
      .disabled(trimmedDraft.isEmpty || trimmedDraft == settings.passcode || settings.isSaving)
      .accessibilityIdentifier("settings-passcode-save")
      if settings.passcode != nil {
        Button("Close Joining", role: .destructive) { Task { await settings.setPasscode(nil) } }
          .disabled(settings.isSaving)
          .accessibilityIdentifier("settings-passcode-clear")
      }
      FailureRows(
        failure: settings.hostFailure, context: "managing the Group", identifier: "settings-host-error")
    } header: {
      Text("Group Passcode")
    } footer: {
      Text(
        settings.passcode == nil
          ? "Joining is closed. Set a passcode and tell it to a friend so they can join."
          : "Friends type this to join. Changing it does not sign anyone out."
      )
      .accessibilityIdentifier("settings-passcode-state")
    }

    Section("People") {
      switch settings.people {
      case .idle, .loading:
        ProgressView()
      case .failed(let failure):
        FailureRows(failure: failure, context: "loading People", identifier: "settings-people-error")
        Button("Try Again") { Task { await settings.loadPeople() } }
      case .loaded(let people):
        ForEach(people) { person in
          NavigationLink {
            PersonView(model: model, person: person, isSelf: person.id == hostId) {
              Task { await settings.loadPeople() }
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
    settings.passcodeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
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
        Text("On \(isSelf ? "your" : "their") new device, choose I Have a Code and type this.")
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
