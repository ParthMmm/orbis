import Foundation
import OrbisDesign

#if canImport(UIKit)
  import UIKit
#endif
#if canImport(AppKit)
  import AppKit
#endif

/// Outcomes of a share-extension save attempt. Tests assert these without hosting an extension.
enum ShareSaveOutcome: Equatable {
  case saved(SavedSet)
  /// The Set is in the Library, but a step after the save failed. Saving again would only say
  /// the Set is already there, so this is a save, with a sentence about what did not happen.
  case savedPartly(SavedSet, message: String)
  case duplicate
  case unreachable(message: String)
  case notConfigured
  case failure(message: String)
}

/// Extracts, validates, and saves a Source Link the way the main app's paste path does.
@MainActor
enum ShareCapture {
  /// The extension starts without the app's launch arguments, so a Debug lane's address never
  /// reaches it: it always talks to the built-in service, or a Debug Mac's development one.
  static var serviceAddress: URL { OrbisService.address(for: []) }

  /// The first supported YouTube or SoundCloud URL found in the attachment payloads.
  static func sourceLink(from payloads: [String]) -> URL? {
    for payload in payloads {
      if let url = LinkField.address(of: payload), SetSource.named(by: url) != nil {
        return url
      }
      for match in urlMatches(in: payload) {
        if let url = LinkField.address(of: match), SetSource.named(by: url) != nil {
          return url
        }
      }
    }
    return nil
  }

  static func save(
    url: URL,
    tags: [String],
    playlistId: String?,
    downloadAfterSaving: Bool,
    settings: any ClientSettingsStore,
    client: OrbisClient? = nil
  ) async -> ShareSaveOutcome {
    guard let client = client ?? settings.configuredClient(address: serviceAddress) else {
      return .notConfigured
    }
    var saved: SavedSet
    do {
      saved = try await client.save(url: url.absoluteString, tags: tags)
    } catch let error as OrbisError {
      switch error {
      case .duplicate:
        return .duplicate
      case .unreachable, .notOrbis:
        preserveOnClipboard(url.absoluteString)
        return .unreachable(message: error.message)
      default:
        preserveOnClipboard(url.absoluteString)
        return .failure(message: error.message)
      }
    } catch {
      preserveOnClipboard(url.absoluteString)
      return .failure(message: "Something went wrong while saving.")
    }
    var unfinished: [String] = []
    if let playlistId {
      do {
        saved = try await client.updatePlaylists(saved.id, playlistIds: [playlistId])
      } catch {
        unfinished.append("It was not added to the Playlist.")
      }
    }
    if downloadAfterSaving {
      do {
        _ = try await client.requestAudioDownload(saved.id)
      } catch {
        unfinished.append("Its download did not start.")
      }
    }
    guard !unfinished.isEmpty else { return .saved(saved) }
    return .savedPartly(saved, message: (unfinished + ["Open Orbis to try again."]).joined(separator: " "))
  }

  static func preserveOnClipboard(_ text: String) {
    #if canImport(UIKit) && !os(tvOS)
      UIPasteboard.general.string = text
    #elseif canImport(AppKit)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }

  private static func urlMatches(in text: String) -> [String] {
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return detector.matches(in: text, options: [], range: range).compactMap { match in
      guard let range = Range(match.range, in: text) else { return nil }
      return String(text[range])
    }
  }
}
