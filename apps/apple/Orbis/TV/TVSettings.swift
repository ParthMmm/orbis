#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// Settings on the TV: who is signed in, what the Library holds, a Sign-in Code for another
  /// device, and Sign Out. The account itself is edited on a phone or Mac, where typing is easy;
  /// the TV reads `SettingsModel` the same way those do.
  struct TVSettings: View {
    let model: AppModel
    @State private var settings: SettingsModel
    @State private var isConfirmingSignOut = false

    init(model: AppModel) {
      self.model = model
      _settings = State(initialValue: SettingsModel(app: model))
    }

    private var keptCount: Int {
      guard case .loaded(let sets) = model.library else { return 0 }
      return sets.filter { $0.downloadState == "ready" }.count
    }

    var body: some View {
      Form {
        account
        Section("Library") {
          LabeledContent("Audio kept", value: keptCount == 1 ? "1 set" : "\(keptCount) sets")
          LabeledContent("Tags", value: model.availableTags.count, format: .number)
        }
        devices
        Section {
        } footer: {
          Text("Orbis \(FailureReport.appVersion)")
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("settings-version")
        }
      }
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
      .task(id: model.client?.token) { await settings.load() }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-settings")
    }

    @ViewBuilder private var account: some View {
      Section {
        switch settings.me {
        case .idle, .loading:
          TVLoading()
        case .failed(let failure):
          FailureRows(failure: failure, context: "loading settings", identifier: "settings-load-error")
          Button("Try Again") { Task { await settings.load() } }
        case .loaded(let person):
          LabeledContent("Username", value: person.username)
            .accessibilityIdentifier("settings-username")
        }
      } header: {
        Text("Account")
      } footer: {
        Text("Change your username, Social, and Auto Download from Orbis on your iPhone or Mac.")
      }
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
  }
#endif
