import OrbisDesign
import SwiftUI

#if os(iOS)
    import UIKit
#else
    import AppKit
#endif

/// Everything a failure needs to say to be worth pasting into a message.
///
/// A screenshot of a heading costs a round trip and still leaves out the address, the build, and
/// the platform. This is the whole thing in one paste, because the person reading it is often not
/// the person in front of the screen.
struct FailureReport: Equatable {
    let failure: OrbisFailure
    /// What the app was doing, in the words the screen would use.
    let context: String

    var text: String {
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
struct CopyFailureButton: View {
    let report: FailureReport
    @State private var copied = false

    var body: some View {
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
    }
}

/// The clipboard, whichever platform is holding it.
@MainActor
func copyToPasteboard(_ text: String) {
    #if os(iOS)
        UIPasteboard.general.string = text
    #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    #endif
}
