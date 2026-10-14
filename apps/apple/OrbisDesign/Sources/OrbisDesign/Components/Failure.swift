import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

nonisolated public struct OrbisFailure: Equatable, Sendable {
  public let title: String
  public let message: String
  public let symbol: String
  public let isRetryable: Bool
  public var address: String?

  public init(
    title: String, message: String, symbol: String, isRetryable: Bool, address: String? = nil
  ) {
    self.title = title
    self.message = message
    self.symbol = symbol
    self.isRetryable = isRetryable
    self.address = address
  }
}

nonisolated public struct FailureReport: Equatable, Sendable {
  public let failure: OrbisFailure
  public let context: String

  public init(failure: OrbisFailure, context: String) {
    self.failure = failure
    self.context = context
  }

  public var text: String {
    var lines = [
      "Orbis \(Self.appVersion) on \(Self.platform)",
      "What: \(failure.title)",
    ]
    if let address = failure.address, !address.isEmpty {
      lines.append("Where: \(address)")
    }
    lines.append("Doing: \(context)")
    lines.append("Detail: \(failure.message)")
    lines.append("When: \(Self.timestamp)")
    return lines.joined(separator: "\n")
  }

  public static var appVersion: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "unknown"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(version) (\(build))"
  }

  static var platform: String {
    #if os(iOS)
      "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)"
    #else
      "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)"
    #endif
  }

  static var timestamp: String {
    ISO8601DateFormatter().string(from: Date())
  }
}

public struct CopyFailureButton: View {
  public let report: FailureReport
  @State private var copied = false

  public init(report: FailureReport) {
    self.report = report
  }

  public var body: some View {
    Button(copied ? "Copied" : "Copy details") {
      copyToPasteboard(report.text)
      copied = true
    }
    .buttonStyle(.plain)
    .font(.orbis.caption)
    .foregroundStyle(Color.orbis.tint)
    .padding(.horizontal, 4)
    .contentShape(.rect)
    .orbisRowHeight()
    .accessibilityLabel(copied ? "Details copied" : "Copy failure details")
    .accessibilityIdentifier("copy-failure")
    .onChange(of: report) { copied = false }
  }
}

@MainActor
func copyToPasteboard(_ text: String) {
  #if canImport(UIKit) && !os(tvOS)
    UIPasteboard.general.string = text
  #elseif canImport(AppKit)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  #endif
}

#Preview("Failure report") {
  let failure = OrbisFailure(
    title: "Cannot reach your library",
    message:
      "Cannot reach your library. Check that Tailscale is connected and the Orbis service is running on the host.",
    symbol: "wifi.exclamationmark",
    isRetryable: true,
    address: "https://vanta.example.ts.net:8444"
  )
  VStack(alignment: .leading, spacing: 12) {
    Label(failure.title, systemImage: failure.symbol).font(.orbis.rowTitle)
    Text(failure.message).font(.orbis.body).foregroundStyle(.secondary)
    CopyFailureButton(report: FailureReport(failure: failure, context: "loading the library"))
  }
  .padding()
  .frame(maxWidth: 420, alignment: .leading)
  .background(Color.orbis.paper)
}

#Preview("Failure report, dark") {
  let failure = OrbisFailure(
    title: "This device is not signed in",
    message: "This device is not signed in to your library. Sign out in Settings and sign in again.",
    symbol: "key.slash",
    isRetryable: false
  )
  VStack(alignment: .leading, spacing: 12) {
    Label(failure.title, systemImage: failure.symbol).font(.orbis.rowTitle)
    Text(failure.message).font(.orbis.body).foregroundStyle(.secondary)
    CopyFailureButton(report: FailureReport(failure: failure, context: "testing a connection"))
  }
  .padding()
  .frame(maxWidth: 420, alignment: .leading)
  .background(Color.orbis.paper)
  .preferredColorScheme(.dark)
}

private struct FailureSample: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      UnavailableState(
        failure: OrbisFailure(
          title: "The service refused the request",
          message: "Check the address points at your Orbis service.",
          symbol: "hand.raised",
          isRetryable: false,
          address: "https://vanta.example.ts.net:8444"
        ),
        context: "changing a set",
        retry: {}
      )
      CopyFailureButton(
        report: FailureReport(
          failure: OrbisFailure(
            title: "Cannot reach your library",
            message: "Check Tailscale.",
            symbol: "wifi.exclamationmark",
            isRetryable: true
          ),
          context: "loading the library"
        )
      )
    }
    .padding()
    .background(Color.orbis.paper)
  }
}

#Preview("Failure, xxxLarge and accessibility5, RTL, Mac") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.macWidth) {
    FailureSample().frame(height: 600)
  }
}

#Preview("Failure, xxxLarge and accessibility5, RTL, iPhone") {
  AccessibilitySizeMatrix(width: AccessibilityPreview.phoneWidth) {
    FailureSample().frame(height: 600)
  }
}
