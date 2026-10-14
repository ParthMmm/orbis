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

/// The signed-in Person's settings: their account, the Group (for the Host, joining and People),
/// Downloads, Devices, and signing out.
struct SettingsView: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
  @State private var isConfirmingSignOut = false
  /// Set when the Host turns joining on, which needs a passcode first. Held here, because a
  /// destination inside the form's lazy rows is ignored.
  @State private var isEditingPasscode = false

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
        group(person)
        if person.host {
          HostSections(
            model: model, settings: settings, hostId: person.id, isEditingPasscode: $isEditingPasscode)
        }
        downloads(person)
      }
      devices
      Section {
        Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
          .accessibilityIdentifier("settings-sign-out")
      } footer: {
        Text("Orbis \(FailureReport.appVersion)")
          .frame(maxWidth: .infinity)
          .padding(.top, 12)
          .accessibilityIdentifier("settings-version")
      }
    }
    .settingsPage()
    .navigationDestination(isPresented: $isEditingPasscode) { PasscodeEditor(settings: settings) }
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

  /// Who is signed in, as a card that opens the page for changing the name.
  private func account(_ person: Me) -> some View {
    Section {
      NavigationLink {
        NameEditor(settings: settings, person: person)
      } label: {
        HStack(spacing: 14) {
          PersonAvatar(person.username, diameter: 56)
          VStack(alignment: .leading, spacing: 2) {
            Text(person.username)
              .font(.title3.weight(.semibold))
            Text(role(person))
              .font(.orbis.detail)
              .foregroundStyle(.secondary)
          }
        }
        .padding(.vertical, 4)
      }
      .accessibilityIdentifier("settings-account")
    }
  }

  private func role(_ person: Me) -> String {
    guard person.host else { return "Member of the Group" }
    guard case .loaded(let people) = settings.people else { return "Host" }
    return people.count == 1 ? "Host · 1 person" : "Host · \(people.count) people"
  }

  private func group(_ person: Me) -> some View {
    Section {
      Toggle(
        "Share with Group",
        isOn: setting(person.social, failure: \.groupFailure) { MeUpdate(social: $0) }
      )
      .disabled(settings.isSaving)
      .accessibilityIdentifier("settings-social")
      FailureRows(failure: settings.groupFailure, context: "changing settings", identifier: "settings-error")
    } header: {
      Text("Group")
    } footer: {
      Text("Your Group sees your Sets, Playlists, and what you play, and you see theirs.")
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
      LabeledContent("Audio kept", value: keptCount == 1 ? "1 set" : "\(keptCount) sets")
      FailureRows(
        failure: settings.downloadsFailure, context: "changing Auto Download",
        identifier: "auto-download-error")
    } header: {
      Text("Downloads")
    } footer: {
      Text("When you save a Set, Orbis keeps its audio so it is ready to play. This applies to all your devices.")
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
        Button("Sign In Another Device") { Task { await settings.makeCode() } }
          .accessibilityIdentifier("settings-sign-in-another")
      }
      FailureRows(
        failure: settings.codeFailure, context: "making a Sign-in Code",
        identifier: "settings-code-error")
    } header: {
      Text("Devices")
    } footer: {
      if settings.code != nil {
        Text("On the new device, choose I Have a Code and type this.")
      }
    }
  }

  private func setting(
    _ value: Bool, failure: ReferenceWritableKeyPath<SettingsModel, OrbisFailure?>,
    _ update: @escaping (Bool) -> MeUpdate
  ) -> Binding<Bool> {
    Binding(
      get: { value },
      set: { enabled in Task { await settings.save(update(enabled), failure: failure) } })
  }
}

/// The page for changing the signed-in Person's name.
private struct NameEditor: View {
  @Bindable var settings: SettingsModel
  let person: Me
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        TextField("Name", text: $settings.username)
          .plainEntry()
          .onSubmit(save)
          .accessibilityIdentifier("settings-username")
        FailureRows(failure: settings.accountFailure, context: "changing settings", identifier: "settings-error")
      } footer: {
        Text("People in your Group see this name.")
      }
    }
    .settingsPage()
    .navigationTitle("Name")
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save", action: save)
          .disabled(trimmed.isEmpty || trimmed == person.username || settings.isSaving)
          .accessibilityIdentifier("settings-username-save")
      }
    }
    // Leaving without saving puts the stored name back.
    .onDisappear {
      if case .loaded(let current) = settings.me { settings.username = current.username }
    }
  }

  private var trimmed: String {
    settings.username.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func save() {
    guard !trimmed.isEmpty, trimmed != person.username else { return }
    let username = trimmed
    Task {
      await settings.save(MeUpdate(username: username), failure: \.accountFailure)
      if settings.accountFailure == nil { dismiss() }
    }
  }
}

/// The Host's rows: whether friends can join, with what passcode, and the People in the Group.
private struct HostSections: View {
  let model: AppModel
  @Bindable var settings: SettingsModel
  let hostId: String
  @Binding var isEditingPasscode: Bool

  var body: some View {
    Section {
      Toggle("Allow Joining", isOn: joining)
        .disabled(settings.isSaving)
        .accessibilityIdentifier("settings-joining")
      // The passcode itself never shows: the Host chose it, and a screen anyone can glance at is
      // no place for the one thing that opens the Group.
      if let passcode = settings.passcode {
        CopyButton(
          title: "Copy Group Passcode", text: passcode, identifier: "settings-passcode-copy",
          row: "Group Passcode")
        NavigationLink("Change Group Passcode") { PasscodeEditor(settings: settings) }
          .accessibilityIdentifier("settings-passcode-row")
      }
      FailureRows(
        failure: settings.hostFailure, context: "managing the Group", identifier: "settings-host-error")
    } footer: {
      if settings.passcode == nil {
        Text("Joining is closed. Turn on Allow Joining and choose a Group Passcode so a friend can join.")
          .accessibilityIdentifier("settings-passcode-state")
      }
    }

    Section("People") {
      switch settings.people {
      case .idle, .loading:
        ProgressView()
      case .failed(let failure):
        FailureRows(failure: failure, context: "loading People", identifier: "settings-people-error")
        Button("Try Again") { Task { await settings.loadPeople() } }
      case .loaded(let people):
        ForEach(people.filter { $0.id != hostId }) { person in
          NavigationLink {
            PersonView(model: model, person: person) {
              Task { await settings.loadPeople() }
            }
          } label: {
            HStack(spacing: 12) {
              PersonAvatar(person.username, diameter: 32)
              Text(person.username)
            }
          }
          .accessibilityIdentifier("person-\(person.username)")
        }
      }
    }
  }

  /// On opens the passcode page, because joining needs a passcode; off closes joining at once.
  private var joining: Binding<Bool> {
    Binding(
      get: { settings.passcode != nil },
      set: { open in
        if open {
          isEditingPasscode = true
        } else {
          Task { await settings.setPasscode(nil) }
        }
      })
  }
}

/// The page for choosing a new Group Passcode. The fields stay hidden and start empty, and the
/// passcode is typed twice, because a typo the Host cannot see would keep every friend out.
private struct PasscodeEditor: View {
  @Bindable var settings: SettingsModel
  @State private var next = ""
  @State private var confirmation = ""
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      Section {
        SecureField("New Passcode", text: $next)
          .plainEntry()
          .accessibilityIdentifier("settings-passcode")
        SecureField("Confirm Passcode", text: $confirmation)
          .plainEntry()
          .onSubmit(save)
          .accessibilityIdentifier("settings-passcode-confirm")
        if mismatched {
          Text("The passcodes do not match.")
            .foregroundStyle(OrbisColor.destructive)
            .accessibilityIdentifier("settings-passcode-mismatch")
        }
        FailureRows(
          failure: settings.hostFailure, context: "managing the Group", identifier: "settings-host-error")
      } footer: {
        Text("Use at least 8 characters. Orbis does not show it after you save, so tell it to friends yourself.")
      }
    }
    .settingsPage()
    .navigationTitle("Group Passcode")
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save", action: save)
          .disabled(trimmed.isEmpty || trimmed != confirmation.trimmed || settings.isSaving)
          .accessibilityIdentifier("settings-passcode-save")
      }
    }
  }

  private var trimmed: String { next.trimmed }

  private var mismatched: Bool {
    !confirmation.isEmpty && trimmed != confirmation.trimmed
  }

  private func save() {
    guard !trimmed.isEmpty, trimmed == confirmation.trimmed else { return }
    let passcode = trimmed
    Task {
      await settings.setPasscode(passcode)
      if settings.passcode == passcode { dismiss() }
    }
  }
}

extension String {
  fileprivate var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// One other Person, as the Host sees them: a Sign-in Code for a new device, and removal.
private struct PersonView: View {
  let model: AppModel
  let person: GroupPerson
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
        Text("On their new device, choose I Have a Code and type this.")
      }
      Section {
        Button("Remove \(person.username)", role: .destructive) { isConfirmingRemoval = true }
          .accessibilityIdentifier("person-remove")
      } footer: {
        Text("They leave the Group and are signed out on every device.")
      }
    }
    .settingsPage()
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

extension View {
  /// Every Settings page draws the same way: a grouped form over the tint glow, so the glass bar
  /// above it has colour to bend on every pushed page too.
  fileprivate func settingsPage() -> some View {
    formStyle(.grouped)
      .font(.orbis.body)
      .scrollContentBackground(.hidden)
      .background { TintGlow() }
  }
}
