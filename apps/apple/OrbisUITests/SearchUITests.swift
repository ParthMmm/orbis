import XCTest

/// Signing in, browsing, and searching the Library.
final class SearchUITests: LibraryJourney {
  func testConnectsBrowsesAndSearchesTheLibrary() throws {
    let app = try launch()

    XCTAssertTrue(
      app.secureTextFields["connection-token"].waitForExistence(timeout: 30),
      "the sign-in screen must appear\n\(app.debugDescription)"
    )
    capture("01-connection")
    connect(app)
    openLibrary(in: app)

    let row = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
    XCTAssertTrue(
      row.waitForExistence(timeout: 60), "a saved Set must appear after connecting\n\(app.debugDescription)")
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

  /// A Set found by search is the reason to search, so the result has to open. The Library row
  /// in the same component opens the same page, on the same build, in the same pass.
  func testOpensASetFromASearchResult() throws {
    let app = try launch(paired: true)

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
    // The page names the Set twice: the header carries the title with its source, and the
    // title stands alone under it. Either identifies the Set that was opened.
    XCTAssertTrue(
      title.label.contains("Night session"),
      "the page must show the Set that was opened, not another one: \(title.label)")
    capture("13-search-result-open")

    // The results and the query are where the person left them, so returning is not a reset.
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(
      heading.waitForExistence(timeout: 20),
      "returning from the page must keep the results\n\(app.debugDescription)")
    XCTAssertEqual(searchText(in: app), "night", "returning must keep the query")
  }

  /// Clearing a search that found nothing is the one way out of the no-match state, so it has
  /// to empty the field and return the screen to the state it shows before any query. It once
  /// left the query in the field and the result area on Loading, forever.
  func testClearsANoMatchSearch() throws {
    let app = try launch(paired: true)

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
