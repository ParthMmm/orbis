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

    private func finish() {
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
      view = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 420))
    }

    override func viewDidLoad() {
      super.viewDidLoad()
      preferredContentSize = NSSize(width: 360, height: 420)
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

    private func finish() {
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

@MainActor
struct ShareConfirmationView: View {
  let payloads: () async -> [String]
  let dismiss: () -> Void

  @State private var link: URL?
  @State private var tagsText = ""
  @State private var playlists: [Playlist] = []
  @State private var playlistId: String?
  @State private var downloadAfterSaving = false
  @State private var status: String?
  @State private var busy = false
  @State private var settings = ClientSettings.forCurrentProcess()

  var body: some View {
    NavigationStack {
      Form {
        if let link {
          Section("Source Link") {
            Text(link.absoluteString)
              .font(.footnote)
              .textSelection(.enabled)
          }
          Section("Organize") {
            TextField("Tags (comma separated)", text: $tagsText)
            Picker("Playlist", selection: $playlistId) {
              Text("None").tag(String?.none)
              ForEach(playlists) { playlist in
                Text(playlist.name).tag(Optional(playlist.id))
              }
            }
            Toggle("Download after saving", isOn: $downloadAfterSaving)
          }
        } else if let status {
          Section {
            Text(status)
          }
        } else {
          Section {
            ProgressView("Reading link…")
          }
        }
        if let status, link != nil {
          Section {
            Text(status)
          }
        }
      }
      .navigationTitle("Save to Orbis")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: dismiss)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await save() }
          }
          .disabled(link == nil || busy)
        }
      }
      .task { await prepare() }
    }
  }

  private func prepare() async {
    let found = ShareCapture.sourceLink(from: await payloads())
    guard let found else {
      status = "Orbis only accepts YouTube and SoundCloud links."
      return
    }
    link = found
    guard let client = settings.configuredClient() else {
      status = "Open Orbis and pair this device first."
      return
    }
    playlists = (try? await client.playlists()) ?? []
  }

  private func save() async {
    guard let link else { return }
    busy = true
    defer { busy = false }
    let tags =
      tagsText
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let outcome = await ShareCapture.save(
      url: link,
      tags: tags,
      playlistId: playlistId,
      downloadAfterSaving: downloadAfterSaving,
      settings: settings
    )
    switch outcome {
    case .saved(let title):
      status = "Saved \(title)."
      try? await Task.sleep(for: .milliseconds(600))
      dismiss()
    case .duplicate:
      status = OrbisError.duplicate.message
    case .unsupported:
      status = "Orbis only accepts YouTube and SoundCloud links."
    case .unreachable(let message), .failure(let message):
      status = "\(message) The link is on your clipboard."
    case .notConfigured:
      status = "Open Orbis and pair this device first."
    }
  }
}
