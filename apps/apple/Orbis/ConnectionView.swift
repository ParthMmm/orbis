import OrbisDesign
import SwiftUI

/// First launch. One address and one device token, tested before they are stored, so a
/// wrong entry never replaces a working configuration.
struct ConnectionView: View {
  @Bindable var model: AppModel
  /// True when a working library is behind this screen, which makes leaving it an option.
  var cancellable = false
  @FocusState private var focus: Field?
  @State private var preferences: Loadable<PersonPreferences> = .idle
  @State private var isSavingPreferences = false

  private enum Field {
    case address
    case token
  }

  var body: some View {
    Form {
      Section {
        TextField("https://vanta.example.ts.net", text: $model.connectionAddress)
          .textContentType(.URL)
          .autocorrectionDisabled()
          .focused($focus, equals: .address)
          .accessibilityIdentifier("connection-address")
        SecureField("Device token", text: $model.connectionToken)
          .focused($focus, equals: .token)
          .accessibilityIdentifier("connection-token")
      } header: {
        Text("Orbis service")
      } footer: {
        Text(
          model.hasStoredToken
            ? "The address of your Orbis service. Leave the token empty to keep the one this device has."
            : "The address of your Orbis service. Pair this device on the host to get a token."
        )
        .font(.orbis.caption)
      }

      Section {
        Button {
          Task { await model.connect() }
        } label: {
          if model.isTestingConnection {
            ProgressView()
          } else {
            Text("Test connection")
          }
        }
        .buttonStyle(OrbisPrimaryButtonStyle())
        .disabled(
          model.connectionAddress.isEmpty
            || (model.connectionToken.isEmpty && !model.hasStoredToken)
            || model.isTestingConnection
        )
        .accessibilityIdentifier("connection-test")

        if cancellable {
          Button("Keep the library I have") { model.closeConnectionEditor() }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connection-cancel")
        }
      }

      if cancellable {
        Section {
          switch preferences {
          case .idle, .loading:
            ProgressView("Loading preferences")
          case .loaded(let person):
            Toggle("Auto Download", isOn: Binding(
              get: { person.autoDownload },
              set: { enabled in Task { await updateAutoDownload(enabled) } }
            ))
            .disabled(isSavingPreferences || model.isTestingConnection)
            .accessibilityIdentifier("auto-download")
            if isSavingPreferences { ProgressView("Saving preference") }
          case .failed(let failure):
            Text(failure.message)
              .foregroundStyle(OrbisColor.destructive)
              .accessibilityIdentifier("auto-download-error")
            Button("Try again") { Task { await loadPreferences() } }
          }
        } header: {
          Text("Downloads")
        } footer: {
          Text("Download audio on your Orbis service when you save a Set. This applies to all your devices.")
        }
      }

      if let failure = model.connectionFailure {
        Section {
          Text(failure.message)
            .foregroundStyle(OrbisColor.destructive)
            .accessibilityIdentifier("connection-error")
          CopyFailureButton(
            report: FailureReport(
              failure: failure, context: "testing a connection address"))
        }
      }
    }
    .formStyle(.grouped)
    .font(.orbis.body)
    .background(Color.orbis.paper)
    .navigationTitle("Connect to Orbis")
    .onAppear { focus = cancellable ? nil : .address }
    .task { if cancellable { await loadPreferences() } }
    // A refusal is written under the button, which on a phone is where the keyboard sits. Put
    // the keyboard away so the answer, and the way to copy it, are actually on screen.
    .onChange(of: model.connectionFailure) { _, failure in
      if failure != nil {
        focus = nil
      }
    }
  }

  private func loadPreferences() async {
    guard let client = model.client else { return }
    preferences = .loading
    do { preferences = .loaded(try await client.preferences()) }
    catch let error as OrbisError { preferences = .failed(error.failure(at: client.address)) }
    catch { preferences = .failed(OrbisError.unreachable.failure(at: client.address)) }
  }

  private func updateAutoDownload(_ enabled: Bool) async {
    guard let client = model.client, !isSavingPreferences else { return }
    isSavingPreferences = true
    defer { isSavingPreferences = false }
    do { preferences = .loaded(try await client.updateAutoDownload(enabled)) }
    catch let error as OrbisError { preferences = .failed(error.failure(at: client.address)) }
    catch { preferences = .failed(OrbisError.unreachable.failure(at: client.address)) }
  }

}
