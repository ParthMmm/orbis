import XCTest

@testable import Orbis

/// The reveal is the step between filing a link and the Set being named, so what it sends and
/// what it leaves behind are both worth pinning.
@MainActor
final class RevealTests: XCTestCase {
  private func set(id: String = "1", title: String = "Night session", tags: [String] = []) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: title,
      source: .youtube,
      tags: tags,
      createdAt: "2026-01-01T00:00:00.000Z",
      creator: "Ada Lovelace",
      artworkUrl: nil,
      durationSeconds: 5400,
      metadataState: "enriched",
      downloadState: "none",
      playlistIds: [],
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }

  private func model(reveal: AppModel.Reveal?) -> AppModel {
    let model = AppModel(settings: MemoryClientSettings())
    model.reveal = reveal
    return model
  }

  func testTheLinkFieldTellsACheckInFlight() {
    XCTAssertEqual(
      SetPresentation.linkState(isFiling: true, failure: nil),
      .checking
    )
  }

  func testTheLinkFieldTellsADuplicateFromAnAddressOrbisDoesNotKnow() {
    XCTAssertEqual(
      SetPresentation.linkState(isFiling: false, failure: .duplicate),
      .duplicate(message: OrbisError.duplicate.message)
    )
    let refusal = OrbisError.server(status: 400, message: "Orbis does not know that address.")
    XCTAssertEqual(
      SetPresentation.linkState(isFiling: false, failure: refusal),
      .invalid(message: refusal.message)
    )
  }

  func testAnIdleFieldHasNothingToSay() {
    XCTAssertEqual(SetPresentation.linkState(isFiling: false, failure: nil), .idle)
  }

  func testARevealWithNothingChangedHasNothingToSend() {
    let open = AppModel.Reveal(set: set(), title: "Night session", tags: [])
    XCTAssertFalse(open.hasChanges)
    XCTAssertTrue(open.titleUntouched)

    XCTAssertTrue(AppModel.Reveal(set: set(), title: "Renamed", tags: []).hasChanges)
    XCTAssertTrue(AppModel.Reveal(set: set(), title: "Night session", tags: ["techno"]).hasChanges)
  }

  /// A failed enrichment leaves a placeholder title, and the field starts empty. Done must not
  /// send that emptiness back over the title the Set still has.
  func testAnEmptyTitleLeavesTheNameThatArrivedAlone() {
    let open = AppModel.Reveal(set: set(title: "YouTube video"), title: "", tags: [])
    XCTAssertNil(open.renamedTitle)
    XCTAssertFalse(open.hasChanges)
    XCTAssertTrue(open.titleUntouched)
  }

  func testARenamedTitleIsTrimmedAndSent() {
    let open = AppModel.Reveal(set: set(), title: "  Closing set  ", tags: [])
    XCTAssertEqual(open.renamedTitle, "Closing set")
    XCTAssertTrue(open.hasChanges)
    XCTAssertFalse(open.titleUntouched)
  }

  func testALongTitleIsCutToWhatTheServiceKeeps() {
    let open = AppModel.Reveal(
      set: set(), title: String(repeating: "a", count: 300), tags: [])
    XCTAssertEqual(open.renamedTitle?.count, 200)
  }

  func testClosingAnUnchangedRevealLeavesAConfirmationAndNoReveal() async {
    let model = model(reveal: AppModel.Reveal(set: set(), title: "Night session", tags: []))
    await model.saveReveal()
    XCTAssertNil(model.reveal)
    XCTAssertEqual(model.fileConfirmation, "Filed “Night session”")
  }

  func testClosingWithoutNamingAnythingLeavesNothingBehind() {
    let model = model(reveal: AppModel.Reveal(set: set(), title: "Night session", tags: []))
    model.closeReveal()
    XCTAssertNil(model.reveal)
    XCTAssertNil(model.revealFailure)
    XCTAssertEqual(model.fileConfirmation, "Filed “Night session”")
  }

  /// While the Library is showing one playlist, filing keeps that list truthful: a Set the
  /// playlist holds joins the top, and one it does not hold stays out instead of inventing
  /// a row the playlist does not have.
  func testFilingIntoThePlaylistBeingViewedKeepsTheListTruthful() async {
    let saveBody = OrbisClientTests.savedSet(title: "Fresh paste", tags: [])
    let belonging = saveBody.replacingOccurrences(
      of: "\"playlistIds\":[]", with: "\"playlistIds\":[\"viewed\"]")
    for (body, expected) in [(belonging, ["Fresh paste", "First"]), (saveBody, ["First"])] {
      let model = AppModel(
        client: OrbisClient(
          address: URL(string: "https://vanta.example.ts.net")!,
          token: "token",
          session: StubProtocol.session { request in
            request.url?.path() == "/sets" && request.httpMethod == "POST"
              ? (201, body) : (500, "{}")
          }
        ), settings: MemoryClientSettings())
      model.library = .loaded([self.set(id: "2", title: "First")])
      model.selectedPlaylistId = "viewed"
      model.linkToFile = "https://youtu.be/abcdefghijk"

      await model.fileLink()

      guard case .loaded(let sets) = model.library else {
        return XCTFail("expected a loaded library")
      }
      XCTAssertEqual(
        sets.map(\.title), expected,
        "a filed Set \(belongsCaseName(expected)) the playlist being viewed")
      XCTAssertEqual(model.linkToFile, "", "a filed link leaves the field")
    }
  }

  private func belongsCaseName(_ expected: [String]) -> String {
    expected.count > 1 ? "joins" : "stays out of"
  }
}
