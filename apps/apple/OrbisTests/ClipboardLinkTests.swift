import XCTest

@testable import Orbis

@MainActor
final class ClipboardLinkTests: XCTestCase {
  func testOnlyYouTubeAndSoundCloudLinksAreFiledFromTheClipboard() {
    XCTAssertTrue(ClipboardLink.fileable("https://youtu.be/tPEMP9oYxTo"))
    XCTAssertTrue(ClipboardLink.fileable("  https://www.youtube.com/watch?v=abcdefghijk\n"))
    XCTAssertTrue(ClipboardLink.fileable("https://soundcloud.com/artist/set"))
    XCTAssertFalse(ClipboardLink.fileable("https://example.com/set"))
    XCTAssertFalse(ClipboardLink.fileable("remember to buy milk"))
    XCTAssertFalse(ClipboardLink.fileable(""))
  }

  func testALinkTheLibraryAlreadyHoldsIsNotFiledAgain() throws {
    let json = """
      {"id":"one","url":"https://youtu.be/tPEMP9oYxTo","title":"Night","source":"youtube",
      "tags":[],"createdAt":"2026-09-11T02:33:14.729Z","metadataState":"ready",
      "downloadState":"none","playbackPositionSeconds":0,"listenCount":0,"finishCount":0}
      """
    let set = try JSONDecoder().decode(SavedSet.self, from: Data(json.utf8))
    XCTAssertTrue(ClipboardLink.isFiled("https://youtu.be/tPEMP9oYxTo\n", in: [set]))
    XCTAssertFalse(ClipboardLink.isFiled("https://youtu.be/another", in: [set]))
  }
}
