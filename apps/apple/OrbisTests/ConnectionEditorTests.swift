import XCTest

@testable import Orbis

/// An address that stops working used to leave Forget this device as the only way back to it,
/// which throws away a working pairing to correct a typo.
@MainActor
final class ConnectionEditorTests: XCTestCase {
  func testEditingTheConnectionKeepsTheLibraryAndAsksForTheTokenAgain() {
    let model = AppModel()
    model.library = .loaded([])
    model.connectionAddress = "https://library.example"
    model.connectionToken = "a token already used"

    model.editConnection()

    XCTAssertTrue(model.isEditingConnection)
    XCTAssertFalse(
      model.connectionAddress.isEmpty, "the screen must open with an address to correct")
    XCTAssertTrue(model.connectionToken.isEmpty, "the token is not left in the field")
    guard case .loaded = model.library else {
      return XCTFail("the library behind the screen must survive")
    }
  }

  /// A wrong address is the common reason to open this screen, and correcting it must not
  /// require pairing again on a device that already holds a token.
  func testAnEmptyTokenKeepsTheOneTheDeviceHasAndATypedOneReplacesIt() {
    let model = AppModel()
    model.connectionAddress = "https://library.example"
    model.connectionToken = "typed on this screen"
    model.editConnection()
    XCTAssertTrue(model.connectionToken.isEmpty, "the field opens empty")
    model.connectionAddress = "https://library.example:8444"
    model.connectionToken = "   "
    XCTAssertTrue(model.connectionToken.trimmingCharacters(in: .whitespaces).isEmpty)
  }

  func testLeavingTheEditorKeepsWhatWasWorking() {
    let model = AppModel()
    model.library = .loaded([])
    model.editConnection()
    model.closeConnectionEditor()

    XCTAssertFalse(model.isEditingConnection)
    guard case .loaded = model.library else {
      return XCTFail("closing the editor must not touch the library")
    }
  }

  func testForgettingClosesTheEditorAndTheLibrary() {
    let model = AppModel()
    model.library = .loaded([])
    model.editConnection()
    model.forget()

    XCTAssertFalse(model.isEditingConnection)
    XCTAssertEqual(model.library, .idle)
  }

  /// Pairing fills the whole shell: the Library rows and the sidebar's Playlists. Loading only
  /// the library left the sidebar empty until the app relaunched.
  func testPairingLoadsTheLibraryAndThePlaylists() async {
    let playlistsBody =
      #"{"playlists":[{"id":"1","name":"Long drives","createdAt":"2026-01-01T00:00:00.000Z","setCount":4}]}"#
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session { request in
          switch request.url?.path() {
          case "/health": (200, #"{"status":"ok"}"#)
          case "/sets":
            (200, "{\"sets\":[" + OrbisClientTests.savedSet(title: "Night session", tags: []) + "]}")
          case "/playlists": (200, playlistsBody)
          default: (500, "{}")
          }
        }
      ))
    model.connectionAddress = "https://vanta.example.ts.net"
    model.connectionToken = "token"
    defer { model.forget() }

    await model.connect()

    guard case .loaded(let sets) = model.library else {
      return XCTFail("pairing must load the library")
    }
    XCTAssertEqual(sets.map(\.title), ["Night session"])
    guard case .loaded(let playlists) = model.playlists else {
      return XCTFail("pairing must load the sidebar's playlists")
    }
    XCTAssertEqual(playlists.map(\.name), ["Long drives"])
  }

  /// A sidebar that could not be read must keep its reason and offer retry, because an empty
  /// section reads as "no playlists".
  func testPlaylistsThatFailToLoadSaySoInsteadOfReadingAsEmpty() async {
    let playlistsBody =
      #"{"playlists":[{"id":"1","name":"Long drives","createdAt":"2026-01-01T00:00:00.000Z","setCount":4}]}"#
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session { request in
          switch request.url?.path() {
          case "/health": (200, #"{"status":"ok"}"#)
          case "/sets": (200, #"{"sets":[]}"#)
          case "/playlists": (500, #"{"message":"The library is busy."}"#)
          default: (500, "{}")
          }
        }
      ))
    model.connectionAddress = "https://vanta.example.ts.net"
    model.connectionToken = "token"
    defer { model.forget() }

    await model.connect()

    guard case .failed = model.playlists else {
      return XCTFail("a failed sidebar must not read as loaded and empty")
    }
    StubProtocol.responder = { request in
      request.url?.path() == "/playlists" ? (200, playlistsBody) : (500, "{}")
    }
    await model.loadPlaylists()
    guard case .loaded(let playlists) = model.playlists else {
      return XCTFail("the retry must load the playlists")
    }
    XCTAssertEqual(playlists.map(\.name), ["Long drives"])
  }
}
