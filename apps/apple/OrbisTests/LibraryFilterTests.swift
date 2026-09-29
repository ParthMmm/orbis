import XCTest

@testable import Orbis

/// The filter is derived from the loaded library rather than fetched, so it is worth pinning
/// what the screen shows for a given library.
@MainActor
final class LibraryFilterTests: XCTestCase {
  private func set(
    id: String, tags: [String] = [], creator: String? = nil, creatorId: String? = nil
  ) -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Set \(id)",
      source: .youtube,
      tags: tags,
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: nil,
      creator: creator,
      creatorId: creatorId,
      artworkUrl: nil,
      artworkLargeUrl: nil,
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
    let model = AppModel(settings: MemoryClientSettings())
    model.library = .loaded(sets)
    return model
  }

  func testShowsOnlySetsCarryingTheActiveTag() {
    let model = library([
      set(id: "1", tags: ["techno"]),
      set(id: "2", tags: ["ambient"]),
      set(id: "3", tags: ["techno", "ambient"]),
    ])
    model.setTagFilter("techno")
    guard case .loaded(let visible) = model.visibleSets else {
      return XCTFail("expected a loaded list")
    }
    XCTAssertEqual(visible.map(\.id), ["1", "3"])
    XCTAssertEqual(model.visibleCount, 2)
    XCTAssertEqual(model.totalCount, 3)

    model.setTagFilter(nil)
    guard case .loaded(let all) = model.visibleSets else {
      return XCTFail("expected a loaded list")
    }
    XCTAssertEqual(all.count, 3)
  }

  func testAnIdMatchesACreatorWhoseNameChanged() {
    let model = library([
      set(id: "1", creator: "Old Name", creatorId: "UC1"),
      set(id: "2", creator: "New Name", creatorId: "UC1"),
      set(id: "3", creator: "New Name", creatorId: "UC2"),
    ])
    model.showCreator(of: model.savedSet("1")!)
    guard case .loaded(let visible) = model.visibleSets else {
      return XCTFail("expected a loaded list")
    }
    XCTAssertEqual(visible.map(\.id), ["1", "2"])
    XCTAssertEqual(model.destination, .library)
    XCTAssertTrue(model.isFilteringLibrary)

    model.clearLibraryFilters()
    XCTAssertEqual(model.visibleCount, 3)
  }

  func testTheNameMatchesASetSavedBeforeItsCreatorHadAnId() {
    let model = library([
      set(id: "1", creator: "Ada", creatorId: "UC1"),
      set(id: "2", creator: "Ada"),
      set(id: "3", creator: "Grace"),
    ])
    model.activeCreator = CreatorFilter(id: nil, name: "Ada")
    guard case .loaded(let visible) = model.visibleSets else {
      return XCTFail("expected a loaded list")
    }
    XCTAssertEqual(visible.map(\.id), ["1", "2"])
  }
}
