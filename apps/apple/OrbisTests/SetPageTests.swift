import Foundation
import XCTest

@testable import Orbis

@MainActor
final class SetPageTests: XCTestCase {
  private func set(
    id: String = "1",
    title: String = "Night session",
    tags: [String] = [],
    playlists: [String] = []
  ) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: title,
      source: .youtube,
      tags: tags,
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: nil,
      creator: nil,
      artworkUrl: nil,
      artworkLargeUrl: nil,
      durationSeconds: nil,
      metadataState: "enriched",
      downloadState: "none",
      playlistIds: playlists,
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }

  private func model(
    sets: [SavedSet],
    status: Int = 200,
    body: String = OrbisClientTests.savedSet(title: "Night session", tags: []),
    failure: URLError? = nil
  ) -> AppModel {
    let session =
      failure.map { StubProtocol.session(failure: $0) }
      ?? StubProtocol.session(status: status, body: body)
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: session
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    model.library = .loaded(sets)
    return model
  }

  func testEachTabKeepsItsOwnOpenSet() {
    let model = model(sets: [set(), set(id: "2", title: "Other")])
    model.destination = .home
    model.openSet("1")

    model.destination = .library
    XCTAssertNil(model.openedSetId, "a Set opened from Home must not appear under Library")
    model.openSet("2")

    model.destination = .home
    XCTAssertEqual(model.openedSetId, "1", "Home keeps the page it had open")
    model.destination = .library
    XCTAssertEqual(model.openedSetId, "2")
  }

  func testRemovingASetClosesItInEveryTab() async {
    let model = model(sets: [set(), set(id: "2", title: "Other")])
    model.destination = .home
    model.openSet("1")
    model.destination = .search
    model.openSet("1")

    await model.remove("1")

    XCTAssertNil(model.openedSetId)
    model.destination = .home
    XCTAssertNil(model.openedSetId)
  }

  func testARefusedRemovalKeepsTheSetAndSaysWhy() async {
    let model = model(
      sets: [set()], status: 500, body: #"{"message":"The library is busy."}"#)

    await model.remove("1")

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.id), ["1"])
    XCTAssertEqual(
      model.setFailure?.message,
      OrbisError.server(status: 500, message: "The library is busy.").failure().message
    )
  }

  func testAnEmptyTitleIsNeverSent() async {
    let model = model(sets: [set()])
    await model.rename("1", to: "   ")
    XCTAssertNil(StubProtocol.lastRequest)
  }

  func testReplacingTagsSendsTheWholeList() async {
    let model = model(sets: [set(tags: ["techno"])])

    await model.replaceTags("1", with: ["techno", "live"])

    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/tags")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["tags"] as? [String], ["techno", "live"])
  }

  func testMovingASetStatesTheWholeMembership() async {
    let model = model(sets: [set(playlists: ["old"])])

    await model.move("1", to: "new")

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/playlists")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["playlistIds"] as? [String], ["new"])
  }

  func testTakingASetOutOfEveryPlaylistSendsNothing() async {
    let model = model(sets: [set(playlists: ["old"])])

    await model.move("1", to: nil)

    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["playlistIds"] as? [String], [])
  }

  func testMovingASetOutOfThePlaylistBeingViewedTakesItsRowWithIt() async {
    let model = model(
      sets: [set(id: "1", playlists: ["viewed"]), set(id: "2", title: "Stays", playlists: ["viewed"])]
    )
    model.selectedPlaylistId = "viewed"

    await model.move("1", to: nil)

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.id), ["2"], "the row must leave with the playlist it moved out of")
  }

  func testRenamingASetInThePlaylistBeingViewedKeepsItsRow() async {
    let body = OrbisClientTests.savedSet(title: "Renamed", tags: []).replacingOccurrences(
      of: "\"playlistIds\":[]", with: "\"playlistIds\":[\"viewed\"]")
    let model = model(sets: [set(id: "1", playlists: ["viewed"])], body: body)
    model.selectedPlaylistId = "viewed"

    await model.rename("1", to: "Renamed")

    guard case .loaded(let sets) = model.library else {
      return XCTFail("expected a loaded library")
    }
    XCTAssertEqual(sets.map(\.title), ["Renamed"], "membership is unchanged, so the row stays")
  }
}
