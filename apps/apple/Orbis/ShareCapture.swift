import Foundation
import OrbisDesign

#if canImport(UIKit)
  import UIKit
#endif
#if canImport(AppKit)
  import AppKit
#endif

enum ShareSaveOutcome: Equatable {
  case saved(title: String)
  case duplicate
  case unreachable(message: String)
  case notConfigured
  case failure(message: String)
}

@MainActor
enum ShareCapture {
  static var serviceAddress: URL { OrbisService.address(for: []) }

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
    do {
      var saved = try await client.save(url: url.absoluteString, tags: tags)
      if let playlistId {
        saved = try await client.updatePlaylists(saved.id, playlistIds: [playlistId])
      }
      if downloadAfterSaving {
        _ = try await client.requestAudioDownload(saved.id)
      }
      return .saved(title: saved.title)
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
