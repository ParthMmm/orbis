import OrbisDesign
import SwiftUI

/// First launch. One address and one device token, tested before they are stored, so a
/// wrong entry never replaces a working configuration.
struct ConnectionView: View {
    @Bindable var model: AppModel
    /// True when a working library is behind this screen, which makes leaving it an option.
    var cancellable = false
    @FocusState private var focus: Field?

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

            if let error = model.connectionError {
                Section {
                    Text(error)
                        .foregroundStyle(OrbisColor.destructive)
                        .accessibilityIdentifier("connection-error")
                }
            }
        }
        .formStyle(.grouped)
        .font(.orbis.body)
        .background(Color.orbis.paper)
        .navigationTitle("Connect to Orbis")
        .onAppear { focus = .address }
    }
}
