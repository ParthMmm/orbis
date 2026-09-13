import Foundation
import XCTest

@testable import Orbis

/// A request that is answered after a newer one began must not publish over it. These tests
/// hold a response back with a semaphore so the ordering the app has to survive is real
/// rather than assumed.
@MainActor
final class SupersessionTests: XCTestCase {
  private func set(id: String, title: String, playlists: [String] = []) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: title,
      source: .youtube,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      creator: nil,
      artworkUrl: nil,
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

  private func libraryBody(title: String) -> String {
    "{\"sets\":[" + OrbisClientTests.savedSet(title: title, tags: []) + "]}"
  }

  /// Waits until the stub has received a request, so a held response is really held before
  /// the test moves on.
  private func waitForARequest() async throws {
    var waited = 0
    while StubProtocol.lastRequest == nil, waited < 200 {
      try await Task.sleep(for: .milliseconds(10))
      waited += 1
    }
    _ = try XCTUnwrap(StubProtocol.lastRequest, "the held request must have started")
  }

  /// The Library the person is leaving behind can still be in flight when they choose
  /// another playlist. The late response must not replace the newer one.
  func testALibraryResponseThatArrivesAfterANewerOneStartedCannotPublish() async throws {
    let oldBody = libraryBody(title: "Old playlist")
    let newBody = libraryBody(title: "New playlist")
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(
          responder: { request in
            request.url?.query()?.contains("playlistId=old") == true
              ? (200, oldBody) : (200, newBody)
          },
          holding: { request in
            request.url?.query()?.contains("playlistId=old") == true ? 0.3 : 0
          }
        )), settings: MemoryClientSettings())
    model.selectedPlaylistId = "old"

    let superseded = Task { await model.loadLibrary() }
    try await waitForARequest()

    model.selectedPlaylistId = "new"
    await model.loadLibrary()
    guard case .loaded(let fresh) = model.library else {
      return XCTFail("the newer load must publish")
    }
    XCTAssertEqual(fresh.map(\.title), ["New playlist"])

    // Finishing this task means the held response was delivered and had its chance to
    // publish; the newer result must have survived it.
    _ = await superseded.value
    guard case .loaded(let after) = model.library else {
      return XCTFail("the library must stay loaded")
    }
    XCTAssertEqual(
      after.map(\.title), ["New playlist"],
      "the older response must be discarded, not published late")
  }

  /// The heading must name the query the results answer. Typing a second query without
  /// submitting cannot relabel the results still on screen.
  func testTheSearchHeadingKeepsTheQueryTheResultsAnswer() async {
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(status: 200, body: libraryBody(title: "Night session"))
      ), settings: MemoryClientSettings())

    model.searchQuery = "night"
    await model.runSearch()
    XCTAssertEqual(model.searchResultsFor, "night")

    model.searchQuery = "nighter"
    XCTAssertEqual(
      model.searchResultsFor, "night",
      "typing without submitting does not change what the results answer to")
  }

  func testClearingTheSearchDropsTheResultsAndTheNameTogether() async {
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(status: 200, body: libraryBody(title: "Night session"))
      ), settings: MemoryClientSettings())
    model.searchQuery = "night"
    await model.runSearch()

    model.clearSearch()

    XCTAssertEqual(model.search, .idle)
    XCTAssertNil(model.searchResultsFor)
  }

  /// Forgetting a device ends every request the old service could still answer, and leaves
  /// nothing selected that belonged to it.
  func testForgettingResetsEverythingThatBelongedToTheService() async {
    let filed = set(id: "1", title: "Night session")
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(status: 200, body: libraryBody(title: "Night session"))
      ), settings: MemoryClientSettings())
    model.library = .loaded([filed])
    model.playlists = .loaded([Playlist(id: "p1", name: "Long drives", setCount: 4)])
    model.selectedPlaylistId = "p1"
    model.activeTag = "techno"
    model.openedSetId = "1"
    model.reveal = AppModel.Reveal(set: filed, title: filed.title, tags: filed.tags)
    model.searchQuery = "night"
    await model.runSearch()
    XCTAssertEqual(model.searchResultsFor, "night")

    model.forget()

    XCTAssertNil(model.client)
    XCTAssertEqual(model.library, .idle)
    XCTAssertEqual(model.search, .idle)
    XCTAssertNil(model.searchResultsFor)
    XCTAssertEqual(model.playlists, .idle)
    XCTAssertNil(model.selectedPlaylistId)
    XCTAssertNil(model.activeTag)
    XCTAssertNil(model.openedSetId)
    XCTAssertNil(model.reveal)
    XCTAssertNil(model.revealFailure)
    XCTAssertFalse(model.isEditingConnection)
  }

  /// Leaving the connection screen dismisses the test that is still out, so a late answer
  /// cannot replace the pairing this device already trusts.
  func testAClosedConnectionEditorCannotCommitALateConnectionTest() async throws {
    let releaseTest = DispatchSemaphore(value: 0)
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session { request in
          if request.url?.path() == "/health" {
            _ = releaseTest.wait(timeout: .now() + 10)
            return (200, #"{"status":"ok"}"#)
          }
          return (500, "{}")
        }
      ), settings: MemoryClientSettings())
    model.editConnection()
    model.connectionAddress = "https://other.example.ts.net"
    model.connectionToken = "typed on this screen"

    let work = Task { await model.connect() }
    try await waitForARequest()

    model.closeConnectionEditor()
    releaseTest.signal()
    await work.value

    XCTAssertEqual(
      model.client?.address.absoluteString, "https://vanta.example.ts.net",
      "a dismissed connection test must not replace the working pairing")
    XCTAssertNil(model.connectionFailure)
  }
}
