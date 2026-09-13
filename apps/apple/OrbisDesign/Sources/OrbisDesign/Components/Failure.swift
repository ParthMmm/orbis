import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// A failure as a screen needs to show it: a heading that says what went wrong, the sentence
/// underneath, and whether trying again could change the answer.
///
/// The heading and the retryability live with the failure rather than with the view, because a
/// Try again button that cannot change the answer is its own kind of lie: a service older than
/// the app is not a network problem, and telling a person it is sends them to check the wrong
/// thing.
nonisolated public struct OrbisFailure: Equatable, Sendable {
  /// What went wrong, in a few words a person can act on.
  public let title: String
  /// The sentence under the heading.
  public let message: String
  /// The symbol that draws the failure. Named rather than typed, so a caller can supply one.
  public let symbol: String
  /// Whether retrying could produce a different answer.
  public let isRetryable: Bool
  /// Where the caller was looking when this happened, which is the first thing worth checking
  /// and the first thing a person forgets to mention.
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

/// Everything a failure needs to say to be worth pasting into a message.
///
/// A screenshot of a heading costs a round trip and still leaves out the address, the build, and
/// the platform. This is the whole thing in one paste, because the person reading it is often not
/// the person in front of the screen.
///
/// `nonisolated` because a failure is built where it happens, which is often not the main actor.
nonisolated public struct FailureReport: Equatable, Sendable {
  public let failure: OrbisFailure
  /// What the app was doing, in the words the screen would use.
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

  static var appVersion: String {
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

/// Copies a failure's details.
///
/// Neutral rather than tinted, because it is never the action the screen is for, and it says so
/// once it has copied rather than opening anything.
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
    // A plain button is only as tappable as its text, which is a few characters wide. The
    // padding and the row height give it an area a finger can actually find.
    .padding(.horizontal, 4)
    .contentShape(.rect)
    .orbisRowHeight()
    .accessibilityLabel(copied ? "Details copied" : "Copy failure details")
    .accessibilityIdentifier("copy-failure")
    .onChange(of: report) { copied = false }
  }
}

/// The clipboard, whichever platform is holding it.
@MainActor
func copyToPasteboard(_ text: String) {
  #if canImport(UIKit)
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
    address: "https://vanta.tail01d084.ts.net:8444"
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
    title: "This device is not paired",
    message: "This device is not paired with your library. Pair it on the host and enter the new token.",
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

/// The failure words and the copy control at the sizes the matrix covers.
private struct FailureSample: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      UnavailableState(
        failure: OrbisFailure(
          title: "The service refused the request",
          message: "Check the address points at your Orbis service.",
          symbol: "hand.raised",
          isRetryable: false,
          address: "https://vanta.tail01d084.ts.net:8444"
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
