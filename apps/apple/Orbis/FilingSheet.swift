import OrbisDesign
import SwiftUI

#if os(iOS)
  import UIKit
#endif

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

enum ClipboardLink {
  nonisolated static func fileable(_ text: String) -> Bool {
    guard let url = LinkField.address(of: text) else { return false }
    return SetSource.named(by: url) != nil
  }

  static func isFiled(_ text: String, in sets: [SavedSet]) -> Bool {
    let wanted = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return sets.contains { $0.url == wanted }
  }

  #if os(iOS)
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
