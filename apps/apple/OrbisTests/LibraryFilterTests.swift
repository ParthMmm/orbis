import XCTest

@testable import Orbis

/// The filter is derived from the loaded library rather than fetched, so it is worth pinning
/// what the screen shows for a given library.
@MainActor
final class LibraryFilterTests: XCTestCase {
    private func set(id: String, tags: [String]) -> SavedSet {
        SavedSet(
            id: id,
            url: "https://www.youtube.com/watch?v=abcdefghijk",
            title: "Set \(id)",
            source: .youtube,
            tags: tags,
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
    }

    private func library(_ sets: [SavedSet]) -> AppModel {
        let model = AppModel()
        model.library = .loaded(sets)
        return model
    }

    func testOffersEveryTagOnceInAStableOrder() {
        let model = library([
            set(id: "1", tags: ["techno", "live"]),
            set(id: "2", tags: ["ambient", "techno"]),
        ])
        XCTAssertEqual(model.availableTags, ["ambient", "live", "techno"])
    }

    func testShowsOnlySetsCarryingTheActiveTag() {
        let model = library([
            set(id: "1", tags: ["techno"]),
            set(id: "2", tags: ["ambient"]),
            set(id: "3", tags: ["techno", "ambient"]),
        ])
        model.setTagFilter("techno")
        guard case let .loaded(visible) = model.visibleSets else {
            return XCTFail("expected a loaded list")
        }
        XCTAssertEqual(visible.map(\.id), ["1", "3"])
        XCTAssertEqual(model.visibleCount, 2)
        XCTAssertEqual(model.totalCount, 3)

        model.setTagFilter(nil)
        guard case let .loaded(all) = model.visibleSets else {
            return XCTFail("expected a loaded list")
        }
        XCTAssertEqual(all.count, 3)
    }

    func testAnEmptyLibraryHasNoFilterToOffer() {
        let model = library([])
        XCTAssertEqual(model.availableTags, [])
        XCTAssertEqual(model.totalCount, 0)
    }
}
