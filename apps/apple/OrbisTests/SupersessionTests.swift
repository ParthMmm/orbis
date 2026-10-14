import Foundation
import XCTest

@testable import Orbis

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

  private func libraryBody(title: String) -> String {
    "{\"sets\":[" + OrbisClientTests.savedSet(title: title, tags: []) + "]}"
  }

  private func waitForARequest() async throws {
    var waited = 0
    while StubProtocol.lastRequest == nil, waited < 200 {
      try await Task.sleep(for: .milliseconds(10))
      waited += 1
    }
    _ = try XCTUnwrap(StubProtocol.lastRequest, "the held request must have started")
  }

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

    _ = await superseded.value
    guard case .loaded(let after) = model.library else {
      return XCTFail("the library must stay loaded")
    }
    XCTAssertEqual(
      after.map(\.title), ["New playlist"],
      "the older response must be discarded, not published late")
  }

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

  func testSigningOutResetsEverythingThatBelongedToTheService() async {
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

    model.signOut()

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
  }

  func testAPlaylistsResponseThatArrivesAfterSigningOutCannotPublish() async throws {
    let releasePlaylists = DispatchSemaphore(value: 0)
    let playlistsBody = #"{"playlists":[{"id":"p1","name":"Long drives","setCount":4}]}"#
    let setsBody = libraryBody(title: "Night session")
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session { request in
          guard request.url?.path() == "/playlists" else { return (200, setsBody) }
          _ = releasePlaylists.wait(timeout: .now() + 10)
          return (200, playlistsBody)
        }
      ), settings: MemoryClientSettings())

    let read = Task { await model.loadPlaylists() }
    try await waitForARequest()

    model.signOut()
    releasePlaylists.signal()
    await read.value

    XCTAssertEqual(
      model.playlists, .idle,
      "the Playlists of a service this device forgot must not come back")
  }

  func testADownloadThatLandsWhileTheLibraryIsLoadingIsNotDropped() async {
    let downloading = OrbisClientTests.savedSet(
      title: "Night session", tags: [], downloadState: "downloading")
    let library = "{\"sets\":[\(downloading)]}"
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session { request in
          request.httpMethod == "POST" ? (200, downloading) : (200, library)
        }
      ), settings: MemoryClientSettings())
    model.library = .loading

    await model.downloadAudio("1")

    guard case .loaded(let sets) = model.library else {
      return XCTFail("the Library must be read again so the download shows")
    }
    XCTAssertEqual(sets.map(\.downloadState), ["downloading"])
  }
}
