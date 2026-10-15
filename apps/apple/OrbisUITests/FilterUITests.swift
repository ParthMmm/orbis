import XCTest

/// Filtering the Library by Tag, from the Library and from Home, and a refused address.
final class FilterUITests: LibraryJourney {
  /// The tag tile is the only way to reach either state from the Library. A control that turns a filter off but never on looks alive while
  /// leaving the Library unfilterable, so both directions are tapped.
  func testFiltersTheLibraryByTag() throws {
    // An untagged Set, so the filter has something to hide.
    _ = try LaneService().saveSet(
      title: "Untagged set", url: "https://www.youtube.com/watch?v=untagged001")
    let app = try launch()
    openLibrary(in: app)

    let tile = app.buttons["tag-filter-techno"]
    XCTAssertTrue(
      tile.waitForExistence(timeout: 60),
      "the tag filter must appear above the rows\n\(app.debugDescription)")
    XCTAssertFalse(tile.isSelected, "the Library must open unfiltered\n\(app.debugDescription)")

    tapAtCentre(of: tile, in: app)
    let hidden = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "tagged techno")).firstMatch
    XCTAssertTrue(
      hidden.waitForExistence(timeout: 20),
      "pressing the tile must turn the filter on\n\(app.debugDescription)")
    XCTAssertTrue(tile.isSelected, "the active tile is selected\n\(app.debugDescription)")
    capture("06-library-filtered")

    tapAtCentre(of: tile, in: app)
    XCTAssertTrue(
      hidden.waitForNonExistence(timeout: 20),
      "pressing the same tile must clear the filter\n\(app.debugDescription)")
    XCTAssertFalse(tile.isSelected, "a cleared filter deselects its tile")
  }

  func testHomeTagOpensFilteredLibraryAfterOpeningASet() throws {
    let app = try launch()
    openLibrary(in: app)

    let night = app.descendants(matching: .any)
      .matching(
        NSPredicate(
          format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "set-row-", "Night session"
        )
      )
      .firstMatch
    XCTAssertTrue(night.waitForExistence(timeout: 30), "the seeded Set must appear in the Library")
    tapAtCentre(of: night, in: app)
    XCTAssertTrue(app.staticTexts["detail-title"].waitForExistence(timeout: 15))

    selectTab("Home", in: app, sidebarIdentifier: "sidebar-home")
    let tag = app.buttons["home-tag-techno"]
    XCTAssertTrue(tag.waitForExistence(timeout: 15), "Home must show the seeded tag")
    capture("home")
    tapAtCentre(of: tag, in: app)

    let filter = app.buttons["tag-filter-techno"]
    XCTAssertTrue(filter.waitForExistence(timeout: 15), "the tag must open the Library list")
    XCTAssertTrue(filter.isSelected, "the Library must filter by the tapped tag")
    XCTAssertFalse(app.staticTexts["detail-title"].exists, "the opened Set must be closed")
    capture("home-tag-filtered-library")
  }

  /// A filter that hides every Set is not an empty collection. The screen once said "Start your
  /// collection" about a collection that was not empty, with no filter row and no way out but a
  /// relaunch.
  ///
  /// The recovery itself is not driven here. A tap into the content of this state does not reach
  /// the app under XCUITest — the same tap, at the same point, on the same build, works when the
  /// app is driven by hand — and neither the filter pill nor the state's own action accepts one.
  /// The press that clears the filter is verified by hand and recorded in
  /// `docs/agents/ui-verification.md`; the model change it makes is `setTagFilter(nil)`, which
  /// `LibraryFilterTests.testShowsOnlySetsCarryingTheActiveTag` covers.
  func testAFilterThatAdmitsNothingIsNotAnEmptyLibrary() throws {
    let app = try launch(filteringBy: "hardgroove")
    openLibrary(in: app)

    XCTAssertTrue(
      noResults(in: app).waitForExistence(timeout: 60),
      "a filter that hides every Set must say so\n\(app.debugDescription)")
    XCTAssertFalse(
      app.staticTexts["Start your collection"].exists,
      "an empty collection is a different state and must not wear that copy")
    XCTAssertTrue(
      app.buttons["Clear filters"].exists,
      "the state must offer the way back\n\(app.debugDescription)")
    XCTAssertTrue(
      app.descendants(matching: .any)["tag-filter-techno"].exists,
      "the filter row must stay, so the filter is still visible where it was set")
    capture("15-library-no-matches")
  }
}
