import OrbisDesign
import SwiftUI

#if os(iOS)
  import UIKit
#endif

/// Adding a Set: a link, then the title and Tags the service read from it, in one sheet.
///
/// A grouped form, the way a system sheet asks for a few facts. Before a link is filed the sheet
/// holds the link field; once the service answers it shows the Set it made, on its artwork's
/// colour, with the title and Tags open to correction. Closing the second step keeps the Set as
/// filed, so the sheet goes back to the link field with a line saying what was filed, ready for
/// the next one.
struct FilingSheet: View {
  @Bindable var model: AppModel
  @Binding var focusLink: Bool
  let close: () -> Void

  @State private var detent: PresentationDetent = .medium

  var body: some View {
    NavigationStack {
      Form {
        if let reveal = model.reveal {
          revealSections(reveal)
        } else {
          linkSections
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
      .background {
        if let reveal = model.reveal {
          ArtworkBackdrop(url: SetPresentation.pageArtwork(reveal.set))
        } else {
          Color.orbis.paper.ignoresSafeArea()
        }
      }
      .navigationTitle(model.reveal == nil ? "Add Set" : "Name Set")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { toolbar }
    }
    .presentationDetents([.medium, .large], selection: $detent)
    // The naming step has a preview, a title and Tags; half a screen would hide the Tags.
    .onChange(of: model.reveal != nil, initial: true) { _, hasReveal in
      if hasReveal { detent = .large }
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    if model.reveal == nil {
      ToolbarItem(placement: .cancellationAction) {
        Button("Close", systemImage: "xmark", role: .close, action: close)
      }
    } else {
      // The Set is already in the Library, so leaving this step changes nothing; it keeps what
      // the service read.
      ToolbarItem(placement: .cancellationAction) {
        Button("Not Now", systemImage: "xmark", role: .close) { model.closeReveal() }
          .accessibilityIdentifier("reveal-dismiss")
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Done", systemImage: "checkmark", role: .confirm) {
          Task { await model.saveReveal() }
        }
        .tint(Color.orbis.tint)
        .disabled(model.isSavingReveal)
        .keyboardShortcut(.defaultAction)
        .accessibilityIdentifier("reveal-done")
      }
    }
  }

  // MARK: The link

  @ViewBuilder private var linkSections: some View {
    Section {
      LinkField(
        link: $model.linkToFile,
        state: SetPresentation.linkState(isFiling: model.isFiling, failure: model.fileFailure),
        focusRequest: $focusLink
      ) {
        Task { await model.fileLink() }
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets())
    } footer: {
      VStack(alignment: .leading, spacing: 10) {
        Text("A YouTube or SoundCloud link. Orbis reads the title, artist and artwork from it.")
        #if os(iOS)
          PasteButton(payloadType: String.self) { pasted in
            guard let text = pasted.first else { return }
            Task { await model.pasteAndFile(text) }
          }
          .labelStyle(.titleAndIcon)
          .buttonBorderShape(.capsule)
          .accessibilityIdentifier("paste-and-file")
        #endif
        if let notice = model.pasteNotice {
          Text(notice)
            .accessibilityIdentifier("paste-notice")
        }
      }
    }
    if model.isFiling {
      Section {
        HStack(spacing: 10) {
          ProgressView()
          Text("Reading the link…")
            .foregroundStyle(.secondary)
        }
      }
    }
    if let confirmation = model.fileConfirmation {
      Section {
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(Color.orbis.tint)
            .accessibilityHidden(true)
          Text(confirmation)
            .accessibilityIdentifier("file-confirmation")
        }
      }
    }
  }

  // MARK: Naming

  @ViewBuilder private func revealSections(_ reveal: AppModel.Reveal) -> some View {
    Section {
      HStack(spacing: 12) {
        Artwork(url: SetPresentation.row(reveal.set).artwork, seed: reveal.set.title, size: .lead)
          .clipShape(.rect(cornerRadius: Radius.button))
        VStack(alignment: .leading, spacing: 4) {
          Text(reveal.set.title)
            .font(.orbis.rowTitle)
            .lineLimit(3)
          Text(
            SetDetail.stampLine(
              source: reveal.set.source.label, subtitle: SetPresentation.subtitle(reveal.set))
          )
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
        }
      }
      .accessibilityElement(children: .combine)
    } footer: {
      Text("Added to your Library. Change the title or Tags, or close to keep them as they are.")
    }

    Section {
      TextField(
        "Title",
        text: Binding(
          get: { model.reveal?.title ?? "" },
          set: { model.reveal?.title = $0 }
        )
      )
      .accessibilityIdentifier("reveal-title")
    } header: {
      Text("Title")
    } footer: {
      if reveal.set.metadataState == "failed", model.revealFailure == nil {
        HStack(spacing: 6) {
          Text("Orbis could not name this set.")
          Button("Try Again") { Task { await model.retryMetadata() } }
            .foregroundStyle(Color.orbis.tint)
            .disabled(model.isSavingReveal)
            .accessibilityIdentifier("reveal-retry")
        }
      }
    }

    TagListEditor(
      tags: Binding(
        get: { model.reveal?.tags ?? [] },
        set: { model.reveal?.tags = $0 }
      ),
      suggestions: model.availableTags,
      category: SetPresentation.category(for:)
    )

    if let failure = model.revealFailure {
      Section {
        Text(failure.message)
          .accessibilityIdentifier("reveal-error")
        CopyFailureButton(report: FailureReport(failure: failure, context: "naming a filed set"))
      }
    }
  }
}

/// The link the clipboard holds, when it is one Orbis takes and the Library does not have yet.
enum ClipboardLink {
  /// Whether text names a source Orbis files: a YouTube or SoundCloud address.
  nonisolated static func fileable(_ text: String) -> Bool {
    guard let url = LinkField.address(of: text) else { return false }
    return SetSource.named(by: url) != nil
  }

  /// Whether the Library already holds this address, so a link copied long ago is not filed
  /// again every time the sheet opens.
  static func isFiled(_ text: String, in sets: [SavedSet]) -> Bool {
    let wanted = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return sets.contains { $0.url == wanted }
  }

  #if os(iOS)
    /// Reads the clipboard only when it holds something shaped like a web address. The shape is
    /// asked of the system without reading, which shows no paste banner; the read itself follows
    /// the press of +, which is the person asking for it.
    @MainActor
    static func read() async -> String? {
      let board = UIPasteboard.general
      guard board.hasURLs || board.hasStrings else { return nil }
      let patterns = try? await board.detectedPatterns(for: [\.probableWebURL])
      guard board.hasURLs || patterns?.contains(\.probableWebURL) == true else { return nil }
      guard let text = board.url?.absoluteString ?? board.string, fileable(text) else {
        return nil
      }
      return text
    }
  #endif
}
