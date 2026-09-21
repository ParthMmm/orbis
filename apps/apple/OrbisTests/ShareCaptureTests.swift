import Foundation
import XCTest

@testable import Orbis

@MainActor
final class ShareCaptureTests: XCTestCase {
  func testSourceLinkAcceptsYouTubeAndSoundCloud() {
    XCTAssertEqual(
      ShareCapture.sourceLink(from: ["https://www.youtube.com/watch?v=abcdefghijk"])?
        .absoluteString,
      "https://www.youtube.com/watch?v=abcdefghijk"
    )
    XCTAssertEqual(
      ShareCapture.sourceLink(from: ["hear https://soundcloud.com/artist/track now"])?
        .host(),
      "soundcloud.com"
    )
  }

  func testSourceLinkRejectsUnsupportedHosts() {
    XCTAssertNil(ShareCapture.sourceLink(from: ["https://example.com/mix"]))
    XCTAssertNil(ShareCapture.sourceLink(from: ["not a link"]))
  }

  func testSaveReportsDuplicateWithoutTouchingClipboardPath() async {
    let settings = MemoryClientSettings()
    settings.serviceAddress = "https://vanta.example.ts.net"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session { request in
      XCTAssertEqual(request.httpMethod, "POST")
      return (409, #"{"message":"duplicate"}"#)
    }
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: URL(string: "https://www.youtube.com/watch?v=abcdefghijk")!,
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings,
      client: client
    )
    XCTAssertEqual(outcome, .duplicate)
  }

  func testSaveReportsUnreachable() async {
    let settings = MemoryClientSettings()
    settings.serviceAddress = "https://vanta.example.ts.net"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session(failure: URLError(.notConnectedToInternet))
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: URL(string: "https://www.youtube.com/watch?v=abcdefghijk")!,
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings,
      client: client
    )
    guard case .unreachable = outcome else {
      return XCTFail("expected unreachable, got \(outcome)")
    }
  }

  func testSaveSucceedsAndCanRequestDownload() async {
    let settings = MemoryClientSettings()
    settings.serviceAddress = "https://vanta.example.ts.net"
    XCTAssertTrue(settings.store(deviceToken: "synthetic-token"))
    let session = StubProtocol.session { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("POST", "/sets"):
        return (
          200,
          #"{"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk","title":"Night","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","metadataState":"ready","downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0}"#
        )
      case ("POST", "/sets/1/audio/download"):
        return (
          200,
          #"{"id":"1","url":"https://www.youtube.com/watch?v=abcdefghijk","title":"Night","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","metadataState":"ready","downloadState":"queued","playbackPositionSeconds":0,"listenCount":0,"finishCount":0}"#
        )
      default:
        return (500, "{}")
      }
    }
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "synthetic-token",
      session: session
    )
    let outcome = await ShareCapture.save(
      url: URL(string: "https://www.youtube.com/watch?v=abcdefghijk")!,
      tags: ["techno"],
      playlistId: nil,
      downloadAfterSaving: true,
      settings: settings,
      client: client
    )
    XCTAssertEqual(outcome, .saved(title: "Night"))
  }

  func testNotConfiguredWhenPairingMissing() async {
    let settings = MemoryClientSettings()
    let outcome = await ShareCapture.save(
      url: URL(string: "https://www.youtube.com/watch?v=abcdefghijk")!,
      tags: [],
      playlistId: nil,
      downloadAfterSaving: false,
      settings: settings
    )
    XCTAssertEqual(outcome, .notConfigured)
  }

  func testMigrateAddressCopiesLegacyDefaults() {
    let legacySuite = "app.orbis.tests.legacy.\(UUID().uuidString)"
    let sharedSuite = "app.orbis.tests.shared.\(UUID().uuidString)"
    let legacy = UserDefaults(suiteName: legacySuite)!
    let shared = UserDefaults(suiteName: sharedSuite)!
    defer {
      legacy.removePersistentDomain(forName: legacySuite)
      shared.removePersistentDomain(forName: sharedSuite)
    }
    legacy.set("https://vanta.example.ts.net:8444", forKey: LiveClientSettings.addressKey)
    ClientSettings.migrateAddressIfNeeded(into: shared, legacy: legacy)
    XCTAssertEqual(
      shared.string(forKey: LiveClientSettings.addressKey),
      "https://vanta.example.ts.net:8444"
    )
  }
}
