import Foundation
import XCTest

@testable import Orbis

/// The Set page changes one Set at a time. What a refusal leaves behind matters as much as what
/// a success does, because the person is looking at the Set when it happens.
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
        let model = AppModel(client: client)
        model.library = .loaded(sets)
        return model
    }

    /// Open leaves the app, so what it would hand to the system is checked rather than driven.
    func testOpenHandsTheSourceAddressToTheSystem() {
        XCTAssertEqual(
            SetPresentation.sourceURL(set())?.absoluteString,
            "https://www.youtube.com/watch?v=abcdefghijk"
        )
    }

    func testOpenHasNothingToOfferWhenTheAddressIsNotOne() {
        let broken = SavedSet(
            id: "1",
            url: "not a url",
            title: "Night session",
            source: .youtube,
            tags: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            creator: nil,
            artworkUrl: nil,
            durationSeconds: nil,
            metadataState: "enriched",
            downloadState: "none",
            playlistIds: [],
            playbackPositionSeconds: 0,
            listenCount: 0,
            finishCount: 0,
            lastListenedAt: nil
        )
        XCTAssertNil(SetPresentation.sourceURL(broken))
    }

    func testOpeningASetRemembersWhichOne() {
        let model = model(sets: [set()])
        model.openSet("1")
        XCTAssertEqual(model.openedSetId, "1")
        XCTAssertEqual(model.savedSet("1")?.title, "Night session")

        model.closeSet()
        XCTAssertNil(model.openedSetId)
    }

    func testRemovingASetTakesItOutOfTheLibraryAndClosesThePage() async {
        let model = model(sets: [set(), set(id: "2", title: "Other")])
        model.openSet("1")

        await model.remove("1")

        guard case let .loaded(sets) = model.library else {
            return XCTFail("expected a loaded library")
        }
        XCTAssertEqual(sets.map(\.id), ["2"])
        XCTAssertNil(model.openedSetId)
        XCTAssertNil(model.setError)
    }

    /// The Set stays on screen with the reason beside it, so the removal can be tried again
    /// rather than leaving a person wondering whether it worked.
    func testARefusedRemovalKeepsTheSetAndSaysWhy() async {
        let model = model(
            sets: [set()], status: 500, body: #"{"message":"The library is busy."}"#)

        await model.remove("1")

        guard case let .loaded(sets) = model.library else {
            return XCTFail("expected a loaded library")
        }
        XCTAssertEqual(sets.map(\.id), ["1"])
        XCTAssertEqual(
            model.setError, OrbisError.server(status: 500, message: "The library is busy.").message
        )
    }

    func testRenamingSendsTheTrimmedTitle() async {
        let model = model(sets: [set()])

        await model.rename("1", to: "  Closing set  ")

        XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PATCH")
        XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/title")
        let sent = try? JSONSerialization.jsonObject(with: XCTUnwrap(StubProtocol.lastBody))
        XCTAssertEqual((sent as? [String: Any])?["title"] as? String, "Closing set")
    }

    func testRenamingToTheSameTitleAsksNothing() async {
        let model = model(sets: [set()])
        await model.rename("1", to: "Night session")
        XCTAssertNil(StubProtocol.lastRequest, "an unchanged title is not worth a request")
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

    /// Orbis holds a Set in one Playlist, so choosing another states the whole membership and
    /// leaves the Playlist it came from.
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

    func testMovingToThePlaylistItIsAlreadyInAsksNothing() async {
        let model = model(sets: [set(playlists: ["same"])])
        await model.move("1", to: "same")
        XCTAssertNil(StubProtocol.lastRequest)
    }
}
