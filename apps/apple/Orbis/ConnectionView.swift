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
  /// The address and key fields stay folded away until a person asks to change the service.
  @State private var isChangingService = false
  @State private var isConfirmingSignOut = false

  private enum Field {
    case address
    case token
  }

  var body: some View {
    Form {
      if cancellable {
        Section {
          serviceCard
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        if isChangingService {
          connectionSection
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

        Section("Library") {
          LabeledContent("Audio kept", value: keptCount == 1 ? "1 set" : "\(keptCount) sets")
          LabeledContent("Tags", value: model.availableTags.count, format: .number)
        }

        Section {
          Button("Sign out this device", role: .destructive) { isConfirmingSignOut = true }
            .accessibilityIdentifier("connection-sign-out")
        } footer: {
          Text("Your library stays on your Orbis service. Sign in again with a code.")
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
    .scrollContentBackground(.hidden)
    .background { TintGlow() }
    .navigationTitle(cancellable ? "Settings" : "Sign in to Orbis")
    .toolbar {
      #if os(iOS)
        if cancellable {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { model.closeConnectionEditor() }
              .accessibilityIdentifier("connection-cancel")
          }
        }
      #endif
    }
    .confirmationDialog(
      "Sign out this device?", isPresented: $isConfirmingSignOut, titleVisibility: .visible
    ) {
      Button("Sign out", role: .destructive) { model.forget() }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text("The address and its token leave this device. Sign in again to come back.")
    }
    .task { if cancellable { await loadPreferences() } }
    // A refusal is written under the button, which on a phone is where the keyboard sits. Put
    // the keyboard away so the answer, and the way to copy it, are actually on screen.
    .onChange(of: model.connectionFailure) { _, failure in
      if failure != nil {
        focus = nil
      }
    }
  }

  private var keptCount: Int {
    guard case .loaded(let sets) = model.library else { return 0 }
    return sets.filter { $0.downloadState == "ready" }.count
  }

  /// Whether the library answered, read from the last load rather than asked again.
  private var status: (label: String, color: Color) {
    switch model.library {
    case .loaded: ("Connected", .green)
    case .failed: ("Cannot reach your service", OrbisColor.destructive)
    case .idle, .loading: ("Checking", .secondary)
    }
  }

  /// The service this device is signed in to, large, with a test of it and the way to change it.
  private var serviceCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 14) {
        Image(systemName: "dot.radiowaves.left.and.right")
          .font(.title2.weight(.semibold))
          .foregroundStyle(.white)
          .frame(width: 52, height: 52)
          .background(Color.orbis.tint.gradient, in: .rect(cornerRadius: 16))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Circle().fill(status.color).frame(width: 8, height: 8)
            Text(status.label)
          }
          .font(.footnote.weight(.semibold))
          .foregroundStyle(status.color)
          Text(model.client?.address.host() ?? model.connectionAddress)
            .font(.title3.weight(.bold))
            .lineLimit(1)
          Text("Orbis service")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
      }
      HStack(spacing: 10) {
        Button {
          Task { await model.connect() }
        } label: {
          Group {
            if model.isTestingConnection {
              ProgressView()
            } else {
              Text("Test connection")
            }
          }
          .font(.headline)
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .disabled(
          model.connectionAddress.isEmpty
            || (model.connectionToken.isEmpty && !model.hasStoredToken)
            || model.isTestingConnection
        )
        .accessibilityIdentifier("connection-test")
        Button {
          isChangingService.toggle()
          if isChangingService { focus = .address }
        } label: {
          Text(isChangingService ? "Hide address" : "Change service")
            .font(.headline)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glass)
        .tint(Color.orbis.tint)
        .accessibilityIdentifier("connection-change")
      }
      .controlSize(.large)
    }
    .padding(18)
    .glassEffect(.regular, in: .rect(cornerRadius: 22))
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
