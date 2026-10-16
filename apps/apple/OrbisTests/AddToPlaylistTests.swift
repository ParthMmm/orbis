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
    XCTAssertEqual(PlaylistChoices.sorted(playlists, by: .name).map(\.id), ["a", "b", "s"])
  }

  func testTheLastPlaylistAddedToLeadsTheRecentsOnce() {
    XCTAssertEqual(PlaylistChoices.remembering("s", in: ["a", "s", "b"]), ["s", "a", "b"])
    XCTAssertEqual(PlaylistChoices.remembering("n", in: []), ["n"])
    XCTAssertEqual(
      PlaylistChoices.remembering("n", in: ["a", "b", "c"], limit: 2), ["n", "a"])
  }
}
