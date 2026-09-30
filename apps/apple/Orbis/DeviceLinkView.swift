import CoreImage.CIFilterBuiltins
import OrbisDesign
import SwiftUI

struct DeviceLinkView: View {
  @Bindable var model: AppModel
  @State private var state: State = .idle
  @State private var attempt = 0

  private enum State {
    case idle
    case starting
    case awaiting(OrbisClient.DeviceLink, CGImage?)
    case expired
    case failed(OrbisFailure)
  }

  var body: some View {
    Section {
      switch state {
      case .idle:
        Text("Approve this device from Orbis on a device where you are already signed in.")
      case .starting:
        ProgressView("Getting a code")
      case .awaiting(let link, let qr):
        Text(link.userCode)
          .font(.system(.largeTitle, design: .monospaced).bold())
          .textSelection(.enabled)
          .accessibilityIdentifier("device-link-code")
        if let qr {
          Image(decorative: qr, scale: 1)
            .interpolation(.none)
            .resizable()
            .scaledToFit()
            .frame(width: 180, height: 180)
            .padding(12)
            .background(.white)
            .accessibilityLabel("Scan to approve this device")
            .accessibilityIdentifier("device-link-qr")
        }
        Link("Open device approval", destination: link.approvalURL)
        Text(
          "Scan the QR code or enter this code at orbis.p11a.xyz/link on your signed-in device. The code expires in 10 minutes."
        )
        ProgressView("Waiting for approval")
      case .expired:
        Text("This code expired. Get a new code to try again.")
          .accessibilityIdentifier("device-link-expired")
      case .failed(let failure):
        Text(failure.message)
          .foregroundStyle(OrbisColor.destructive)
          .accessibilityIdentifier("device-link-error")
      }
      Button(attempt == 0 ? "Sign in with Device Link" : "Get a new code") {
        attempt += 1
      }
      .accessibilityIdentifier("device-link-start")
      .disabled(isStarting)
    } header: {
      Text("Sign in")
    }
    .task(id: attempt) {
      guard attempt > 0 else { return }
      await signIn()
    }
  }

  private var isStarting: Bool {
    if case .starting = state { return true }
    return false
  }

  private func signIn() async {
    state = .starting
    do {
      let address = try OrbisClient.address(from: model.connectionAddress)
      let client = OrbisClient(address: address, token: "")
      #if os(macOS)
        let label = "Orbis on Mac"
      #elseif os(tvOS)
        let label = "Orbis on Apple TV"
      #else
        let label = "Orbis on iPhone or iPad"
      #endif
      let link = try await client.startDeviceLink(label: label)
      try Task.checkCancellation()
      let filter = CIFilter.qrCodeGenerator()
      filter.message = Data(link.approvalURL.absoluteString.utf8)
      filter.correctionLevel = "M"
      let qr = filter.outputImage.flatMap { CIContext().createCGImage($0, from: $0.extent) }
      state = .awaiting(link, qr)
      while !Task.isCancelled {
        try await Task.sleep(for: .seconds(2))
        let answer = try await client.pollDeviceLink(secret: link.pollSecret)
        try Task.checkCancellation()
        switch answer {
        case .pending: continue
        case .expired:
          state = .expired
          return
        case .approved(let key):
          model.connectionToken = key
          await model.connect()
          model.connectionToken = ""
          if let failure = model.connectionFailure { state = .failed(failure) }
          return
        }
      }
    } catch {
      guard !Task.isCancelled else { return }
      let failure = (error as? OrbisError ?? .unreachable)
        .failure(at: URL(string: model.connectionAddress))
      state = .failed(failure)
    }
  }
}
