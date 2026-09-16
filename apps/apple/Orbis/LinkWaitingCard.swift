import OrbisDesign
import SwiftUI

#if os(iOS)
  import UIKit

  /// A link on the clipboard, offered for filing above the Library.
  ///
  /// The card appears only while the clipboard holds a link, and it never reads the clipboard
  /// to find out: pattern detection answers whether the text is shaped like a web address
  /// without showing the person the paste banner. Reading waits for the button, which is the
  /// system's own paste control, so the tap is the permission.
  /// Nothing is drawn when there is no link, so the Library stays the collection alone.
  struct LinkWaitingCard: View {
    /// What the last paste had to say when the clipboard held nothing worth filing.
    let notice: String?
    let file: (String) -> Void

    @State private var hasLink = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
      Group {
        if hasLink || notice != nil {
          card
        }
      }
      .task { await check() }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { Task { await check() } }
      }
      .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) {
        _ in
        Task { await check() }
      }
    }

    /// Whether the clipboard holds something shaped like a web address. A copied link is
    /// usually plain text, which `hasURLs` does not count.
    private func check() async {
      let board = UIPasteboard.general
      guard board.hasURLs || board.hasStrings else {
        hasLink = false
        return
      }
      let patterns = try? await board.detectedPatterns(for: [\.probableWebURL])
      hasLink = board.hasURLs || patterns?.contains(\.probableWebURL) == true
    }

    private var card: some View {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 3) {
            ListingLabel("Clipboard", tint: Color.orbis.tint)
            Text("A link is waiting")
              .font(.orbis.rowTitle)
          }
          Spacer()
          PasteButton(payloadType: String.self) { pasted in
            guard let text = pasted.first else { return }
            file(text)
          }
          .labelStyle(.titleOnly)
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("paste-and-file")
        }
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Rectangle().fill(Color.orbis.tint).frame(height: 2) }
        .overlay(alignment: .bottom) { Divider() }
        if let notice {
          Text(notice)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("paste-notice")
        }
      }
      .accessibilityIdentifier("link-waiting")
    }
  }
#endif
