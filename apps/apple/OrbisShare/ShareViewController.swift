import OrbisDesign
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import UIKit

  /// Compact share confirmation: validates the Source Link, optional Tags / Playlist /
  /// Download-after-saving, then saves through the same OrbisClient contract as the app.
  @MainActor
  final class ShareViewController: UIViewController {
    private var hosting: UIHostingController<ShareConfirmationView>?

    override func viewDidLoad() {
      super.viewDidLoad()
      let root = ShareConfirmationView(
        payloads: { [weak self] in await self?.loadPayloads() ?? [] },
        dismiss: { [weak self] in self?.finish() }
      )
      let host = UIHostingController(rootView: root)
      hosting = host
      addChild(host)
      host.view.frame = view.bounds
      host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(host.view)
      host.didMove(toParent: self)
    }

    private var finished = false

    /// Done and the saved screen's own timeout can both arrive, and the request completes once.
    private func finish() {
      guard !finished else { return }
      finished = true
      extensionContext?.completeRequest(returningItems: nil)
    }

    private func loadPayloads() async -> [String] {
      await ShareExtensionPayloads.load(from: extensionContext?.inputItems)
    }
  }
#elseif os(macOS)
  import AppKit

  @MainActor
  final class ShareViewController: NSViewController {
    private var hosting: NSHostingController<ShareConfirmationView>?

    override func loadView() {
      view = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 560))
    }

    override func viewDidLoad() {
      super.viewDidLoad()
      preferredContentSize = NSSize(width: 400, height: 560)
      let root = ShareConfirmationView(
        payloads: { [weak self] in await self?.loadPayloads() ?? [] },
        dismiss: { [weak self] in self?.finish() }
      )
      let host = NSHostingController(rootView: root)
      hosting = host
      addChild(host)
      host.view.frame = view.bounds
      host.view.autoresizingMask = [.width, .height]
      view.addSubview(host.view)
    }

    private var finished = false

    /// Done and the saved screen's own timeout can both arrive, and the request completes once.
    private func finish() {
      guard !finished else { return }
      finished = true
      extensionContext?.completeRequest(returningItems: nil)
    }

    private func loadPayloads() async -> [String] {
      await ShareExtensionPayloads.load(from: extensionContext?.inputItems)
    }
  }
#endif

enum ShareExtensionPayloads {
  static func load(from items: [Any]?) async -> [String] {
    guard let items = items as? [NSExtensionItem] else { return [] }
    var payloads: [String] = []
    for item in items {
      guard let attachments = item.attachments else { continue }
      for provider in attachments {
        if let url = await loadURL(from: provider) {
          payloads.append(url.absoluteString)
        }
        if let text = await loadText(from: provider) {
          payloads.append(text)
        }
      }
    }
    return payloads
  }

  private static func loadURL(from provider: NSItemProvider) async -> URL? {
    let types = [UTType.url.identifier, "public.url"]
    for type in types where provider.hasItemConformingToTypeIdentifier(type) {
      return await withCheckedContinuation { continuation in
        provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
          if let url = item as? URL {
            continuation.resume(returning: url)
          } else if let text = item as? String, let url = URL(string: text) {
            continuation.resume(returning: url)
          } else if let data = item as? Data,
            let url = URL(dataRepresentation: data, relativeTo: nil)
          {
            continuation.resume(returning: url)
          } else {
            continuation.resume(returning: nil)
          }
        }
      }
    }
    return nil
  }

  private static func loadText(from provider: NSItemProvider) async -> String? {
    let types = [UTType.plainText.identifier, "public.plain-text"]
    for type in types where provider.hasItemConformingToTypeIdentifier(type) {
      return await withCheckedContinuation { continuation in
        provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
          continuation.resume(returning: item as? String)
        }
      }
    }
    return nil
  }
}

/// Where the share sheet is. A refusal and a saved Set each take the whole sheet; a failed save
/// keeps the form, so the person can change something and try again.
enum ShareStage: Equatable {
  case reading
  case unsupported
  case signedOut
  case editing(URL)
  case saved(SavedSet)
}

@MainActor
struct ShareConfirmationView: View {
  let payloads: () async -> [String]
  let dismiss: () -> Void

  @State private var stage = ShareStage.reading
  @State private var tags: [String] = []
  @State private var suggestions: [String] = []
  @State private var playlists: [Playlist] = []
  @State private var playlistId: String?
  @State private var downloadAfterSaving = false
  @State private var isSaving = false
  @State private var failure: String?
  /// Rises on every refusal, so the symbol shakes again for a second one.
  @State private var refusals = 0
  @State private var settings = ClientSettings.forCurrentProcess()

  var body: some View {
    NavigationStack {
      content
        .navigationTitle(isSaved ? "Saved" : "Save to Orbis")
        .toolbarTitleDisplayMode(.inline)
        .toolbar { toolbar }
    }
    .orbisAnimation(.filingSucceeded, value: stage)
    .sensoryFeedback(.success, trigger: isSaved) { _, saved in saved }
    .sensoryFeedback(.error, trigger: refusals)
    .task { await prepare() }
  }

  private var isSaved: Bool {
    if case .saved = stage { return true }
    return false
  }

  @ViewBuilder private var content: some View {
    switch stage {
    case .reading:
      VStack(spacing: 12) {
        Image(systemName: "waveform")
          .font(.largeTitle.weight(.semibold))
          .foregroundStyle(Color.orbis.tint)
          .orbisWorking(true)
          .accessibilityHidden(true)
        Text("Reading the link…")
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { TintGlow() }
    case .unsupported:
      refusal(
        "No YouTube or SoundCloud link", symbol: "link",
        message: "Share a link from YouTube or SoundCloud to save it.")
    case .signedOut:
      refusal(
        "Sign in to Orbis", symbol: "person.crop.circle.badge.exclamationmark",
        message: "Open Orbis and sign in, then share the link again.")
    case .editing(let link):
      form(link)
    case .saved(let set):
      saved(set)
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if isSaved {
      ToolbarItem(placement: .confirmationAction) {
        Button("Done", systemImage: "checkmark", role: .confirm, action: dismiss)
          .tint(Color.orbis.tint)
      }
    } else {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel", systemImage: "xmark", role: .close, action: dismiss)
      }
      if case .editing = stage {
        ToolbarItem(placement: .confirmationAction) {
          if isSaving {
            ProgressView()
              .accessibilityLabel("Saving")
          } else {
            Button("Save", systemImage: "checkmark", role: .confirm) {
              Task { await save() }
            }
            .tint(Color.orbis.tint)
            .keyboardShortcut(.defaultAction)
          }
        }
      }
    }
  }

  private func refusal(_ title: String, symbol: String, message: String) -> some View {
    ContentUnavailableView {
      Label(title, systemImage: symbol)
    } description: {
      Text(message)
    }
    .background { TintGlow() }
  }

  private func form(_ link: URL) -> some View {
    Form {
      Section {
        HStack(spacing: 12) {
          Artwork(url: nil, seed: link.absoluteString, size: .row)
          VStack(alignment: .leading, spacing: 6) {
            if let source = SetSource.named(by: link) {
              SourceStamp(source.label)
            }
            Text(link.absoluteString)
              .font(.orbis.detail)
              .foregroundStyle(.secondary)
              .lineLimit(2)
              .truncationMode(.middle)
              .textSelection(.enabled)
          }
        }
        .accessibilityElement(children: .combine)
      } footer: {
        Text("Orbis reads the title, artist and artwork when it saves.")
      }

      if let failure {
        Section {
          Label {
            Text(failure)
          } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.secondary)
              .orbisSymbolEffect(.filingFailed, trigger: refusals)
          }
        }
      }

      TagListEditor(
        tags: $tags, suggestions: suggestions, title: "Tags",
        category: SetPresentation.category(for:))

      Section("Playlist") {
        PlaylistPicker(
          selection: $playlistId,
          choices: playlists.map {
            .init(id: $0.id, name: $0.name, category: SetPresentation.category(for: $0.name))
          })
        Toggle("Download after saving", isOn: $downloadAfterSaving)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background { TintGlow() }
    .disabled(isSaving)
  }

  private func saved(_ set: SavedSet) -> some View {
    let artwork = SetPresentation.row(set).artwork
    return VStack(spacing: 14) {
      Artwork(url: artwork, seed: set.title, size: .header)
        .frame(maxWidth: 300)
        .padding(.bottom, 6)
      Label("Added to your Library", systemImage: "checkmark.circle.fill")
        .font(.orbis.label)
        .foregroundStyle(Color.orbis.tint)
      Text(set.title)
        .font(.orbis.title)
        .multilineTextAlignment(.center)
        .lineLimit(3)
      Text(
        SetDetail.stampLine(source: set.source.label, subtitle: SetPresentation.subtitle(set))
      )
      .font(.orbis.detail)
      .foregroundStyle(.secondary)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { ArtworkBackdrop(url: artwork) }
    .accessibilityElement(children: .combine)
  }

  private func prepare() async {
    guard let link = ShareCapture.sourceLink(from: await payloads()) else {
      stage = .unsupported
      return
    }
    guard let client = settings.configuredClient(address: ShareCapture.serviceAddress) else {
      stage = .signedOut
      return
    }
    stage = .editing(link)
    // The Sets, not /tags, because /tags is alphabetical and the editor offers the newest first.
    async let library = try? client.library()
    async let lists = try? client.playlists()
    suggestions = SetPresentation.orderedTags(await library ?? [], recent: [])
    playlists = await lists ?? []
  }

  private func save() async {
    guard case .editing(let link) = stage else { return }
    isSaving = true
    defer { isSaving = false }
    let outcome = await ShareCapture.save(
      url: link,
      tags: tags,
      playlistId: playlistId,
      downloadAfterSaving: downloadAfterSaving,
      settings: settings
    )
    switch outcome {
    case .saved(let set):
      failure = nil
      stage = .saved(set)
      try? await Task.sleep(for: .seconds(1.6))
      dismiss()
    case .duplicate:
      refuse(OrbisError.duplicate.message)
    case .unreachable(let message), .failure(let message):
      refuse("\(message) The link is on your clipboard.")
    case .notConfigured:
      stage = .signedOut
    }
  }

  private func refuse(_ message: String) {
    failure = message
    refusals += 1
  }
}
