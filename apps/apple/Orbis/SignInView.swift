import OrbisDesign
import SwiftUI

/// A signed-out device signs in one of two ways (ADR 0020): a new Person joins with the Group
/// Passcode, and someone who already uses Orbis types a Sign-in Code from another device.
struct SignInView: View {
  @Bindable var model: AppModel
  @State private var choice: Choice?

  private enum Choice: Hashable {
    case join
    case code
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 32) {
        Text("Orbis")
          .font(.orbis.largeTitle)
          .accessibilityAddTraits(.isHeader)
        VStack(spacing: 12) {
          Button {
            choice = .join
          } label: {
            Text("I'm New").frame(maxWidth: .infinity)
          }
          .buttonStyle(OrbisPrimaryButtonStyle())
          .accessibilityIdentifier("signin-new")
          Button {
            choice = .code
          } label: {
            Text("I Have a Code").frame(maxWidth: .infinity)
          }
          .buttonStyle(OrbisSecondaryButtonStyle())
          .accessibilityIdentifier("signin-have-code")
        }
        .controlSize(.large)
        .frame(maxWidth: 320)
      }
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.orbis.paper)
      .navigationDestination(item: $choice) { choice in
        switch choice {
        case .join: JoinForm(model: model)
        case .code: CodeForm(model: model)
        }
      }
    }
  }
}

private struct JoinForm: View {
  @Bindable var model: AppModel
  @State private var username = ""
  @State private var passcode = ""
  @FocusState private var focus: Field?

  private enum Field {
    case username
    case passcode
  }

  private var canJoin: Bool {
    !username.isEmpty && !passcode.isEmpty && !model.isSigningIn
  }

  var body: some View {
    Form {
      Section {
        TextField("Username", text: $username)
          .plainEntry()
          .focused($focus, equals: .username)
          .submitLabel(.next)
          .onSubmit { focus = .passcode }
          .accessibilityIdentifier("signin-username")
        TextField("Group Passcode", text: $passcode)
          .autocorrectionDisabled()
          #if os(iOS)
            .textInputAutocapitalization(.characters)
          #endif
          .focused($focus, equals: .passcode)
          .submitLabel(.join)
          .onSubmit(join)
          .accessibilityIdentifier("signin-passcode")
      } footer: {
        Text("Ask your Host for the Group Passcode.")
      }
      Section {
        Button(action: join) {
          SignInButtonLabel(title: "Join", isWorking: model.isSigningIn)
        }
        .buttonStyle(OrbisPrimaryButtonStyle())
        .disabled(!canJoin)
        .accessibilityIdentifier("signin-join")
      }
      SignInFailureSection(failure: model.signInFailure)
    }
    .signInForm(title: "I'm New", model: model, focus: $focus, first: .username)
  }

  private func join() {
    guard canJoin else { return }
    Task { await model.signIn(.join(username: username, passcode: passcode)) }
  }
}

private struct CodeForm: View {
  @Bindable var model: AppModel
  @State private var code = ""
  @FocusState private var focus: Bool?

  private var canRedeem: Bool {
    SignInCode.normalized(code).count == SignInCode.length && !model.isSigningIn
  }

  var body: some View {
    Form {
      Section {
        TextField("ABCD-EFGH", text: $code)
          #if os(iOS)
            .textInputAutocapitalization(.characters)
          #endif
          .plainEntry()
          .font(.system(.title2, design: .monospaced))
          .focused($focus, equals: true)
          .submitLabel(.go)
          .onSubmit(redeem)
          .accessibilityLabel("Sign-in Code")
          .accessibilityIdentifier("signin-code")
      } footer: {
        Text(
          "On a device where you use Orbis, open Settings and choose Sign in another device. Lost every device? Your Host can show you a Sign-in Code."
        )
      }
      Section {
        Button(action: redeem) {
          SignInButtonLabel(title: "Sign In", isWorking: model.isSigningIn)
        }
        .buttonStyle(OrbisPrimaryButtonStyle())
        .disabled(!canRedeem)
        .accessibilityIdentifier("signin-redeem")
      }
      SignInFailureSection(failure: model.signInFailure)
    }
    .signInForm(title: "I Have a Code", model: model, focus: $focus, first: true)
  }

  private func redeem() {
    guard canRedeem else { return }
    Task { await model.signIn(.code(code)) }
  }
}

private struct SignInButtonLabel: View {
  let title: String
  let isWorking: Bool

  var body: some View {
    Group {
      if isWorking {
        ProgressView()
      } else {
        Text(title)
      }
    }
    .frame(maxWidth: .infinity)
  }
}

private struct SignInFailureSection: View {
  let failure: OrbisFailure?

  var body: some View {
    if failure != nil {
      Section {
        FailureRows(failure: failure, context: "signing in", identifier: "signin-error")
      }
    }
  }
}

extension View {
  /// Usernames and codes are typed as they are: no capitals, corrections, or
  /// suggestions added.
  func plainEntry() -> some View {
    self
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
  }

  fileprivate func signInForm<Field: Hashable>(
    title: String, model: AppModel, focus: FocusState<Field?>.Binding, first: Field
  ) -> some View {
    self
      .formStyle(.grouped)
      .font(.orbis.body)
      .background(Color.orbis.paper)
      .navigationTitle(title)
      .onAppear {
        model.signInFailure = nil
        focus.wrappedValue = first
      }
      .onChange(of: model.signInFailure) { _, failure in
        if failure != nil { focus.wrappedValue = nil }
      }
  }
}
