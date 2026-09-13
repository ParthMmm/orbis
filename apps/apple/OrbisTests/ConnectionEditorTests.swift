import XCTest

@testable import Orbis

/// An address that stops working used to leave Forget this device as the only way back to it,
/// which throws away a working pairing to correct a typo.
@MainActor
final class ConnectionEditorTests: XCTestCase {
  func testEditingTheConnectionKeepsTheLibraryAndAsksForTheTokenAgain() {
    let model = AppModel(settings: MemoryClientSettings())
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
    let model = AppModel(settings: MemoryClientSettings())
    model.connectionAddress = "https://library.example"
    model.connectionToken = "typed on this screen"
    model.editConnection()
    XCTAssertTrue(model.connectionToken.isEmpty, "the field opens empty")
    model.connectionAddress = "https://library.example:8444"
    model.connectionToken = "   "
    XCTAssertTrue(model.connectionToken.trimmingCharacters(in: .whitespaces).isEmpty)
  }

  func testLeavingTheEditorKeepsWhatWasWorking() {
    let model = AppModel(settings: MemoryClientSettings())
    model.library = .loaded([])
    model.editConnection()
    model.closeConnectionEditor()

    XCTAssertFalse(model.isEditingConnection)
    guard case .loaded = model.library else {
      return XCTFail("closing the editor must not touch the library")
    }
  }

  func testForgettingClosesTheEditorAndTheLibrary() {
    let model = AppModel(settings: MemoryClientSettings())
    model.library = .loaded([])
    model.editConnection()
    model.forget()

    XCTAssertFalse(model.isEditingConnection)
    XCTAssertEqual(model.library, .idle)
  }

  /// A device that refuses to hold the new token must keep the pairing it already has. The
  /// address is only committed after the token is stored, so a refused save changes nothing
  /// and says so where the address was typed.
  func testARefusedSaveKeepsTheWorkingPairingAndSaysSo() async {
    let settings = RefusingClientSettings(
      address: "https://library.example",
      token: "synthetic-old-token"
    )
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://library.example")!,
        token: "synthetic-old-token",
        session: StubProtocol.session { request in
          request.url?.path() == "/health" ? (200, #"{"status":"ok"}"#) : (500, "{}")
        }
      ),
      settings: settings
    )
    model.library = .loaded([])
    model.connectionAddress = "https://replacement.example"
    model.connectionToken = "synthetic-new-token"

    await model.connect()

    XCTAssertEqual(settings.storeAttempts, 1, "the token is offered to the store once")
    XCTAssertEqual(
      settings.serviceAddress, "https://library.example",
      "a refused save must not adopt the new address")
    XCTAssertEqual(
      settings.deviceToken, "synthetic-old-token",
      "a refused save must not forget the pairing the device already holds")
    XCTAssertEqual(
      model.client?.address.absoluteString, "https://library.example",
      "the model must keep the client it was already using")
    XCTAssertTrue(model.hasStoredToken, "the device still holds the token it had")
    guard case .loaded = model.library else {
      return XCTFail("a refused save must not throw away the working Library session")
    }

    guard let failure = model.connectionFailure else {
      return XCTFail("a refused save must say so where the address was typed")
    }
    let expected = OrbisError.storageRefused.failure()
    XCTAssertEqual(failure.title, expected.title)
    XCTAssertEqual(failure.symbol, expected.symbol)
    XCTAssertTrue(failure.isRetryable, "a refused save is worth another try")

    for text in [failure.title, failure.message, failure.address ?? ""] {
      XCTAssertFalse(
        text.contains("synthetic-new-token"),
        "the typed token must not reach user-facing text: \(text)")
      XCTAssertFalse(
        text.contains("synthetic-old-token"),
        "the stored token must not reach user-facing text: \(text)")
    }
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
      ), settings: MemoryClientSettings())
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
      ), settings: MemoryClientSettings())
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

/// A store that refuses every write, like a device whose keychain will not take the token. It
/// keeps the pairing it already had, so a test can prove a refused save changed nothing.
@MainActor
final class RefusingClientSettings: ClientSettingsStore {
  var serviceAddress: String?
  private let token: String?
  private(set) var storeAttempts = 0

  init(address: String?, token: String?) {
    serviceAddress = address
    self.token = token
  }

  var deviceToken: String? { token }

  @discardableResult
  func store(deviceToken newToken: String?) -> Bool {
    storeAttempts += 1
    return false
  }
}
