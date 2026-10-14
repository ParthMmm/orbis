import XCTest

final class SearchUITests: LibraryJourney {
  func testBrowsesAndSearchesTheLibrary() throws {
    let app = try launch()
    openLibrary(in: app)

    let row = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
    XCTAssertTrue(
      row.waitForExistence(timeout: 60), "a saved Set must appear\n\(app.debugDescription)")
    capture("02-library-loaded")

    let searchSpot = openSearch(in: app)
    submitSearch("night", in: app, spot: searchSpot)
    XCTAssertTrue(row.waitForExistence(timeout: 30), "search must find the Set")
    capture("03-search-results")

    submitSearch("zzzznothing", in: app, spot: searchSpot)
    XCTAssertTrue(
      noResults(in: app).waitForExistence(timeout: 30),
      "an unmatched search must say so\n\(app.debugDescription)")
    capture("04-search-no-results")
  }

  func testOpensASetFromASearchResult() throws {
    let app = try launch()

    let spot = openSearch(in: app)
    submitSearch("night", in: app, spot: spot)

    let heading = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Results for")).firstMatch
    XCTAssertTrue(
      heading.waitForExistence(timeout: 30),
      "a submitted search must name the query it answers\n\(app.debugDescription)")

    let result = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
    XCTAssertTrue(
      result.waitForExistence(timeout: 30),
      "search must list the Set it found\n\(app.debugDescription)")
    tapAtCentre(of: result, in: app)

    let title = app.staticTexts["detail-title"].firstMatch
    XCTAssertTrue(
      title.waitForExistence(timeout: 30),
      "a search result must open the Set's page\n\(app.debugDescription)")
    XCTAssertTrue(
      title.label.contains("Night session"),
      "the page must show the Set that was opened, not another one: \(title.label)")
    capture("13-search-result-open")

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(
      heading.waitForExistence(timeout: 20),
      "returning from the page must keep the results\n\(app.debugDescription)")
    XCTAssertEqual(searchText(in: app), "night", "returning must keep the query")
  }

  func testClearsANoMatchSearch() throws {
    let app = try launch()

    let spot = openSearch(in: app)
    submitSearch("zzzznothing", in: app, spot: spot)
    XCTAssertTrue(
      noResults(in: app).waitForExistence(timeout: 30),
      "an unmatched search must say so\n\(app.debugDescription)")

    app.buttons["Clear search"].tap()

    XCTAssertTrue(
      untouchedSearch(in: app).waitForExistence(timeout: 20),
      "clearing must return to the state before any query\n\(app.debugDescription)")
    XCTAssertFalse(noResults(in: app).exists, "the no-match state goes with the query")
    XCTAssertEqual(searchText(in: app), "", "clearing must empty the field")
    XCTAssertFalse(
      app.descendants(matching: .any).matching(identifier: "library-loading").firstMatch.exists,
      "clearing must not leave a loading state behind")
    capture("14-search-cleared")
  }
}
