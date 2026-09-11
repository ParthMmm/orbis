import OrbisDesign
import SwiftUI

/// First launch. One address and one device token, tested before they are stored, so a
/// wrong entry never replaces a working configuration.
struct ConnectionView: View {
    @Bindable var model: AppModel
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
                    "The address of your Orbis service. Pair this device on the host to get a token."
                )
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
                        || model.connectionToken.isEmpty
                        || model.isTestingConnection
                )
                .accessibilityIdentifier("connection-test")
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
        .navigationTitle("Connect to Orbis")
        .onAppear { focus = .address }
    }
}
