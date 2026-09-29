import XCTest

@testable import Orbis

@MainActor
final class AddToPlaylistTests: XCTestCase {
  private let playlists = [
    Playlist(id: "b", name: "bass trap bangers", setCount: 3),
    Playlist(id: "a", name: "August - 26", setCount: 12),
    Playlist(id: "s", name: "September - 26", setCount: 7),
  ]

  func testNameSortsTheWayFinderDoes() {
    XCTAssertEqual(AddToPlaylistSheet.sorted(playlists, by: .name).map(\.id), ["a", "b", "s"])
  }

  func testTheLastPlaylistAddedToLeadsTheRecentsOnce() {
    XCTAssertEqual(AddToPlaylistSheet.remembering("s", in: ["a", "s", "b"]), ["s", "a", "b"])
    XCTAssertEqual(AddToPlaylistSheet.remembering("n", in: []), ["n"])
    XCTAssertEqual(
      AddToPlaylistSheet.remembering("n", in: ["a", "b", "c"], limit: 2), ["n", "a"])
  }
}
