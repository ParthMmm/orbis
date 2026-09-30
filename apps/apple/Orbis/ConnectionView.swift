import OrbisDesign
import SwiftUI

/// First launch signs in to the built-in service with a Device Link, or with a pasted key (ADR
/// 0016). Once signed in, the same screen edits the address and the key, each tested before it
/// is stored, so a wrong entry never replaces a working configuration.
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
      if cancellable {
        connectionSection
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

          Button("Keep the library I have") { model.closeConnectionEditor() }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connection-cancel")
        }
      } else {
        deviceLinkSection
        keySection
      }

      if cancellable {
        Section {
          switch preferences {
          case .idle, .loading:
            ProgressView("Loading preferences")
          case .loaded(let person):
            Toggle(
              "Auto Download",
              isOn: Binding(
                get: { person.autoDownload },
                set: { enabled in Task { await updateAutoDownload(enabled) } }
              )
            )
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
    .navigationTitle(cancellable ? "Connect to Orbis" : "Sign in to Orbis")
    .task { if cancellable { await loadPreferences() } }
    // A refusal is written under the button, which on a phone is where the keyboard sits. Put
    // the keyboard away so the answer, and the way to copy it, are actually on screen.
    .onChange(of: model.connectionFailure) { _, failure in
      if failure != nil {
        focus = nil
      }
    }
  }

  /// The address and the key of an existing pairing, for correcting either one.
  private var connectionSection: some View {
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
      Text("The address of your Orbis service. Leave the token empty to keep the one this device has.")
        .font(.orbis.caption)
    }
  }

  /// Sign in with a code that a signed-in device approves.
  private var deviceLinkSection: some View {
    Section {
      switch model.deviceLink {
      case .idle, .starting:
        TextField("Device name", text: $model.deviceLinkLabel)
          .autocorrectionDisabled()
          .accessibilityIdentifier("device-link-label")
        Button {
          focus = nil
          model.startDeviceLink()
        } label: {
          if model.deviceLink == .starting {
            ProgressView()
          } else {
            Text("Get a code")
          }
        }
        .buttonStyle(OrbisPrimaryButtonStyle())
        .disabled(model.deviceLink == .starting)
        .accessibilityIdentifier("device-link-start")
      case .waiting(let userCode):
        DeviceLinkCode(userCode: userCode)
        Button("Cancel") { model.cancelDeviceLink() }
          .accessibilityIdentifier("device-link-cancel")
      case .expired:
        Text("That code expired before anyone approved it.")
          .accessibilityIdentifier("device-link-expired")
        Button("Get a new code") { model.startDeviceLink() }
          .buttonStyle(OrbisPrimaryButtonStyle())
          .accessibilityIdentifier("device-link-restart")
      }
      if let failure = model.deviceLinkFailure {
        Text(failure.message)
          .foregroundStyle(OrbisColor.destructive)
          .accessibilityIdentifier("device-link-error")
      }
    } header: {
      Text("Sign in with a code")
    } footer: {
      Text("Approve the code on a device where you already use Orbis. No key to copy.")
        .font(.orbis.caption)
    }
  }

  /// Sign in with a key the Host sent, which stays available beside the code.
  private var keySection: some View {
    Section {
      SecureField("API key", text: $model.connectionToken)
        .focused($focus, equals: .token)
        .accessibilityIdentifier("connection-token")
      Button {
        Task { await model.connect() }
      } label: {
        if model.isTestingConnection {
          ProgressView()
        } else {
          Text("Sign in with this key")
        }
      }
      .buttonStyle(OrbisSecondaryButtonStyle())
      .disabled(model.connectionToken.isEmpty || model.isTestingConnection)
      .accessibilityIdentifier("connection-test")
    } header: {
      Text("Use a key instead")
    }
  }

  private func loadPreferences() async {
    guard let client = model.client else { return }
    preferences = .loading
    do { preferences = .loaded(try await client.preferences()) } catch let error as OrbisError {
      preferences = .failed(error.failure(at: client.address))
    } catch { preferences = .failed(OrbisError.unreachable.failure(at: client.address)) }
  }

  private func updateAutoDownload(_ enabled: Bool) async {
    guard let client = model.client, !isSavingPreferences else { return }
    isSavingPreferences = true
    defer { isSavingPreferences = false }
    do { preferences = .loaded(try await client.updateAutoDownload(enabled)) } catch let error as OrbisError {
      preferences = .failed(error.failure(at: client.address))
    } catch { preferences = .failed(OrbisError.unreachable.failure(at: client.address)) }
  }

}

/// The code a new device shows while it waits, and a QR code for the approval page, so a phone
/// that is already signed in can scan it instead of typing.
private struct DeviceLinkCode: View {
  let userCode: String

  var body: some View {
    let link = DeviceLink.approvalURL(for: userCode)
    VStack(spacing: 16) {
      Text("On a device where you already use Orbis, open orbis.p11a.xyz/link and enter this code, or scan it.")
        .font(.orbis.detail)
        .foregroundStyle(OrbisColor.muted)
        .multilineTextAlignment(.center)
      Text(DeviceLink.formatted(userCode))
        .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
        .textSelection(.enabled)
        .accessibilityLabel(DeviceLink.formatted(userCode))
        .accessibilityIdentifier("device-link-code")
      if let qr = DeviceLink.qrCode(for: link) {
        Image(qr, scale: 1, label: Text("QR code for the approval page"))
          .interpolation(.none)
          .resizable()
          .scaledToFit()
          .frame(width: 180, height: 180)
          .padding(8)
          .background(.white, in: .rect(cornerRadius: 8))
          .accessibilityValue(link)
          .accessibilityIdentifier("device-link-qr")
      }
      HStack(spacing: 8) {
        ProgressView()
        Text("Waiting for approval")
      }
      .font(.orbis.detail)
      .foregroundStyle(OrbisColor.muted)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("device-link-waiting")
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }
}
