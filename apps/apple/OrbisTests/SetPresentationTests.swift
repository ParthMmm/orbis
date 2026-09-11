import OrbisDesign
import XCTest

@testable import Orbis

@MainActor
final class SetPresentationTests: XCTestCase {
    private func makeSet(
        url: String = "https://www.youtube.com/watch?v=abcdefghijk",
        title: String = "Night session",
        tags: String = #"["techno","breaks"]"#,
        createdAt: String = "2026-09-11T02:33:14.729Z",
        playbackPositionSeconds: Int = 0,
        downloadState: String = "none"
    ) throws -> SavedSet {
        let json = """
        {"id":"one","url":"\(url)","title":"\(title)","source":"youtube","tags":\(tags),
        "createdAt":"\(createdAt)","creator":null,"artworkUrl":null,"durationSeconds":null,
        "metadataState":"pending","titleEditedByUser":false,"downloadState":"\(downloadState)",
        "playlistIds":[],"retainedAudioBytes":null,"retainedAudioFormat":null,
        "playbackPositionSeconds":\(playbackPositionSeconds),"listenCount":0,"finishCount":0,
        "lastListenedAt":null}
        """
        return try JSONDecoder().decode(SavedSet.self, from: Data(json.utf8))
    }

    func testRowCarriesIdentitySourceTagsAndDate() throws {
        let model = SetPresentation.row(try makeSet(), position: 2)

        XCTAssertEqual(model.index, 3)
        XCTAssertEqual(model.source, "YouTube")
        XCTAssertEqual(model.title, "Night session")
        XCTAssertEqual(model.url, "youtube.com/watch?v=abcdefghijk")
        XCTAssertEqual(model.tags.map(\.name), ["techno", "breaks"])
        XCTAssertEqual(model.added.timeIntervalSince1970, 1_789_093_994.729, accuracy: 0.01)
    }

    func testDisplayURLCarriesNoSchemeOrWWW() {
        XCTAssertEqual(SetPresentation.displayURL("https://www.youtube.com/watch?v=x"), "youtube.com/watch?v=x")
        XCTAssertEqual(SetPresentation.displayURL("http://soundcloud.com/a/b"), "soundcloud.com/a/b")
        XCTAssertEqual(SetPresentation.displayURL("https://vanta.tail01d084.ts.net/sets"), "vanta.tail01d084.ts.net/sets")
    }

    func testTagColourIsStableAndIndependentOfOtherTags() throws {
        let alone = SetPresentation.row(try makeSet(tags: #"["techno"]"#), position: 0)
        let mixed = SetPresentation.row(try makeSet(tags: #"["breaks","techno"]"#), position: 0)

        let technoAlone = alone.tags.first { $0.name == "techno" }?.category
        let technoMixed = mixed.tags.first { $0.name == "techno" }?.category

        XCTAssertEqual(SetPresentation.category(for: "techno"), SetPresentation.category(for: "techno"))
        XCTAssertEqual(technoAlone, technoMixed)
        XCTAssertNotEqual(
            SetPresentation.category(for: "techno"),
            SetPresentation.category(for: "breaks")
        )
    }

    func testStateAppearsOnlyWhenThereIsSomethingToSay() throws {
        XCTAssertNil(SetPresentation.row(try makeSet(), position: 0).state)
        XCTAssertNil(SetPresentation.row(try makeSet(downloadState: "none"), position: 0).state)

        let both = try XCTUnwrap(
            SetPresentation.row(try makeSet(playbackPositionSeconds: 3661, downloadState: "queued"), position: 0).state
        )
        XCTAssertEqual(both.resumeAt, 3661)
        XCTAssertEqual(both.label, "Resume at 1:01:01 · Download queued")

        let downloadOnly = try XCTUnwrap(
            SetPresentation.row(try makeSet(downloadState: "ready"), position: 0).state
        )
        XCTAssertNil(downloadOnly.resumeAt)
        XCTAssertEqual(downloadOnly.label, "Audio ready")
    }

    func testDownloadLabelsCoverEveryServerState() {
        XCTAssertNil(SetPresentation.downloadLabel("none"))
        XCTAssertEqual(SetPresentation.downloadLabel("queued"), "Download queued")
        XCTAssertEqual(SetPresentation.downloadLabel("downloading"), "Downloading")
        XCTAssertEqual(SetPresentation.downloadLabel("ready"), "Audio ready")
        XCTAssertEqual(SetPresentation.downloadLabel("failed"), "Download failed")
        XCTAssertEqual(SetPresentation.downloadLabel("canceled"), "Download canceled")
        XCTAssertNil(SetPresentation.downloadLabel("something-new"))
    }

    func testDateParsesWithAndWithoutFractionalSeconds() {
        XCTAssertEqual(
            SetPresentation.date(from: "2026-09-11T02:33:14.729Z").timeIntervalSince1970,
            1_789_093_994.729,
            accuracy: 0.01
        )
        XCTAssertEqual(
            SetPresentation.date(from: "2026-09-11T02:33:14Z").timeIntervalSince1970,
            1_789_093_994,
            accuracy: 0.01
        )
        XCTAssertEqual(SetPresentation.date(from: "not a date"), .distantPast)
    }
}
