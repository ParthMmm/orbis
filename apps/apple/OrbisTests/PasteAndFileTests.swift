import XCTest

@testable import Orbis

/// Pasting is the shortcut, so what it refuses matters as much as what it files.
@MainActor
final class PasteAndFileTests: XCTestCase {
  private func model() -> AppModel {
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: StubProtocol.session(
        status: 201, body: OrbisClientTests.savedSet(title: "Night session", tags: []))
    )
    let model = AppModel(client: client)
    // A loaded library keeps a successful filing from reloading, so the last request stays the save.
    model.library = .loaded([])
    return model
  }

  private func source(_ address: String) -> SetSource? {
    SetSource.named(by: URL(string: address)!)
  }

  func testTheHostDecidesWhichServiceAndThePathStaysTheServicesBusiness() {
    XCTAssertEqual(source("https://youtu.be/abcdefghijk"), .youtube)
    XCTAssertEqual(source("https://music.youtube.com/watch?v=x"), .youtube)
    XCTAssertEqual(source("https://m.soundcloud.com/a/b"), .soundcloud)
    XCTAssertNil(source("https://example.com/watch?v=abcdefghijk"))
    XCTAssertNil(source("https://spotify.com/track/x"))
    // A host that merely ends in the name is not the service.
    XCTAssertNil(source("https://youtube.com.example.test/watch?v=a"))
  }

  func testAPastedYouTubeLinkIsFiledWithoutTypingAnything() async {
    let model = model()
    await model.pasteAndFile("https://youtu.be/tPEMP9oYxTo")
    XCTAssertNil(model.pasteNotice)
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets")
    let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
    XCTAssertEqual((sent as? [String: Any])?["url"] as? String, "https://youtu.be/tPEMP9oYxTo")
  }

  func testAPastedSoundCloudLinkIsFiled() async {
    let model = model()
    await model.pasteAndFile("https://soundcloud.com/rinsefm/skin-on-skin")
    XCTAssertNil(model.pasteNotice)
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets")
  }

  /// A paste Orbis cannot take is refused before the round trip, and the field is left alone
  /// because it holds what the person put there.
  func testAPasteThatIsNotALinkChangesNothing() async {
    let model = model()
    model.linkToFile = "typed by hand"
    await model.pasteAndFile("https://open.spotify.com/track/abc")
    XCTAssertEqual(model.pasteNotice, "The clipboard holds no YouTube or SoundCloud link.")
    XCTAssertNil(StubProtocol.lastRequest, "nothing is sent for a link Orbis does not take")
    XCTAssertEqual(model.linkToFile, "typed by hand")
  }

  func testAPasteOfPlainTextIsRefusedTheSameWay() async {
    let model = model()
    await model.pasteAndFile("just some words")
    XCTAssertNotNil(model.pasteNotice)
    XCTAssertNil(StubProtocol.lastRequest)
  }
}
