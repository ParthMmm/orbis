import Foundation
import XCTest

@testable import Orbis

private func playlistSavedSetJSON(
  id: String, title: String, playlists: [String] = ["p1"]
) -> String {
  let playlistIds = playlists.map { "\"\($0)\"" }.joined(separator: ",")
  return """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=abcdefghijk","title":"\(title)",\
    "source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,\
    "artworkUrl":null,"durationSeconds":null,"metadataState":"enriched","downloadState":"none",\
    "playlistIds":[\(playlistIds)],"playbackPositionSeconds":0,"listenCount":0,\
    "finishCount":0,"lastListenedAt":null}
    """
}

@MainActor
final class PlaylistTests: XCTestCase {
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
    playlists: [Playlist] = [],
    members: [SavedSet] = [],
    library: [SavedSet] = []
  ) -> AppModel {
    let playlistsBody =
      #"{"playlists":[\#(playlists.map { #"{"id":"\#($0.id)","name":"\#($0.name)","setCount":\#($0.setCount)}"# }.joined(separator: ","))]}"#
    let membersBody =
      #"{"sets":[\#(members.map { playlistSavedSetJSON(id: $0.id, title: $0.title) }.joined(separator: ","))]}"#
    let session = StubProtocol.session { request in
      switch request.url?.path() {
      case "/playlists":
        return (200, playlistsBody)
      case "/playlists/p1/sets":
        return (200, membersBody)
      default:
        let libraryBody = library.map {
          playlistSavedSetJSON(id: $0.id, title: $0.title, playlists: $0.playlistIds)
        }.joined(separator: ",")
        return (200, #"{"sets":[\#(libraryBody)]}"#)
      }
    }
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: session
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    model.playlists = .loaded(playlists)
    model.library = .loaded(library)
    model.openPlaylist("p1")
    model.playlistMembers = .loaded(members)
    return model
  }

  func testRemovingMembershipSendsTheRemainingIds() async {
    let model = model(
      playlists: [Playlist(id: "p1", name: "Evenings", setCount: 2)],
      members: [set(id: "1", title: "First"), set(id: "2", title: "Second")],
      library: [set(id: "1", title: "First"), set(id: "2", title: "Second")]
    )
    await model.removeSetFromPlaylist("p1", setId: "1")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/playlists/p1/sets")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody)) as? [String: Any]
    XCTAssertEqual(sent?["setIds"] as? [String], ["2"])
  }

  func testReorderingMembershipSendsTheNewOrder() async {
    let model = model(
      playlists: [Playlist(id: "p1", name: "Evenings", setCount: 2)],
      members: [set(id: "1", title: "First"), set(id: "2", title: "Second")]
    )
    await model.movePlaylistMembers("p1", from: IndexSet(integer: 1), to: 0)
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody)) as? [String: Any]
    XCTAssertEqual(sent?["setIds"] as? [String], ["2", "1"])
  }

  func testDeletingAPlaylistClosesItsDetail() async {
    let session = StubProtocol.session { request in
      switch request.url?.path() {
      case "/playlists/p1":
        return (200, #"{"id":"p1","name":"Evenings","setCount":0}"#)
      case "/playlists":
        return (200, #"{"playlists":[]}"#)
      default:
        return (200, #"{"sets":[]}"#)
      }
    }
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: session
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    model.playlists = .loaded([Playlist(id: "p1", name: "Evenings", setCount: 0)])
    model.openPlaylist("p1")
    await model.deletePlaylist("p1")
    XCTAssertNil(model.openedPlaylistId)
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "DELETE")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/playlists/p1")
  }
}
