import XCTest

@testable import Orbis

/// The reveal is the step between filing a link and the Set being named, so what it sends and
/// what it leaves behind are both worth pinning.
@MainActor
final class RevealTests: XCTestCase {
    private func set(title: String = "Night session", tags: [String] = []) -> SavedSet {
        SavedSet(
            id: "1",
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
            playbackPositionSeconds: 0,
            listenCount: 0,
            finishCount: 0,
            lastListenedAt: nil
        )
    }

    private func model(reveal: AppModel.Reveal?) -> AppModel {
        let model = AppModel()
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
        XCTAssertNil(model.revealError)
        XCTAssertEqual(model.fileConfirmation, "Filed “Night session”")
    }
}
