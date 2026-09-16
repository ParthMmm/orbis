import XCTest

/// Drives the real first-launch path against a server the lane starts. The address and
/// token come from the environment so the test types them exactly as a person would.
final class LibraryUITests: XCTestCase {
  private func launch(filteringBy tag: String? = nil) throws -> XCUIApplication {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    let app = XCUIApplication()
    app.launchArguments.append("-orbisResetSettings")
    if let tag {
      app.launchArguments.append(contentsOf: ["-orbisStartTagFiltered", tag])
    }
    app.launchEnvironment["ORBIS_TEST_SETTINGS"] = "memory"
    app.launchEnvironment["ORBIS_UI_TEST_ADDRESS"] = address
    app.launchEnvironment["ORBIS_UI_TEST_TOKEN"] = token
    app.launch()
    return app
  }

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Taps the centre of an element's own frame, with the point taken from the window. XCUITest
  /// reports a hit point of `{-1, -1}` for some controls inside the Library's scroll view — it
  /// decides the element is not visible, tries to scroll it into view, and gives up — while the
  /// same element reports `hittable` in the accessibility tree and responds to a tap at the point
  /// its own frame names. The point is measured from the window rather than from the element's
  /// coordinate space, which is the difference that makes the tap land.
  private func tapAtCentre(of element: XCUIElement, in app: XCUIApplication) {
    let frame = element.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      .tap()
  }

  /// Search is a tab on a compact width class and a sidebar item on a regular one, so the
  /// journey proves the platform's navigation rather than assuming one shape.
  /// Returns the point the field sits at on iPhone, so a later query can focus it again once
  /// the button it replaced is gone.
  @discardableResult
  private func openSearch(in app: XCUIApplication) -> XCUICoordinate? {
    let tab = app.tabBars.buttons["Search"]
    if tab.waitForExistence(timeout: 8) {
      // On iPhone the search tab morphs into the field in the same spot. The first tap
      // selects it; the second, on the same point, focuses the field and raises the keyboard.
      // XCUITest cannot address the field once the morph settles, so the spot is remembered.
      // The point is taken from the frame now, because the button is gone after the first tap
      // and a coordinate made from it would resolve against nothing.
      let frame = tab.frame
      let spot = app.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      spot.tap()
      sleep(2)
      spot.tap()
      sleep(1)
      return spot
    }
    let sidebarSearch = app.buttons["sidebar-search"]
    XCTAssertTrue(
      sidebarSearch.waitForExistence(timeout: 15),
      "Search must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    sidebarSearch.tap()
    return nil
  }

  /// The prompt the field shows while it is empty. XCUITest reports it as the field's value.
  private static let searchPrompt = "Title, tag, or source link"

  /// What the field holds, with the prompt an empty field shows treated as nothing.
  private func searchText(in app: XCUIApplication) -> String {
    let value = (app.searchFields.firstMatch.value as? String) ?? ""
    return value == Self.searchPrompt ? "" : value
  }

  /// Focuses the field. It replaces the tab button once the tab is selected, and XCUITest
  /// cannot address it after the morph settles, so the first focus uses the point the button
  /// occupied and a later one uses the bar's centre, where a query narrows the field to.
  private func focusSearch(in app: XCUIApplication, spot: XCUICoordinate?) {
    guard !app.keyboards.firstMatch.exists else { return }
    if let spot {
      let window = app.windows.firstMatch.frame
      app.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: window.midX, dy: spot.screenPoint.y))
        .tap()
    } else {
      app.searchFields.firstMatch.tap()
    }
    XCTAssertTrue(
      app.keyboards.firstMatch.waitForExistence(timeout: 15),
      "the Search destination must offer a field\n\(app.debugDescription)"
    )
  }

  /// Types a query and submits it. Whatever the field held is replaced, so one launch can
  /// search twice.
  private func submitSearch(_ query: String, in app: XCUIApplication, spot: XCUICoordinate?) {
    focusSearch(in: app, spot: spot)
    let existing = searchText(in: app)
    if !existing.isEmpty {
      app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    app.typeText(query)
    app.typeText("\n")
  }

  /// The state an unmatched search shows, matched by its words rather than its shape.
  private func noResults(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "No matching sets")).firstMatch
  }

  private func untouchedSearch(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Search your")).firstMatch
  }

  func testConnectsBrowsesAndSearchesTheLibrary() throws {
    let app = try launch()

    XCTAssertTrue(
      app.textFields["connection-address"].waitForExistence(timeout: 30),
      "the connection screen must appear\n\(app.debugDescription)"
    )
    capture("01-connection")
    connect(app)

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

  /// Pairs the app the way a person would, so a journey that begins after connecting does
  /// not restate the connection screen's details.
  private func connect(_ app: XCUIApplication) {
    let address = app.textFields["connection-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 30), "the connection screen must appear\n\(app.debugDescription)")

    address.tap()
    address.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_ADDRESS"] ?? "")

    let token = app.secureTextFields["connection-token"]
    XCTAssertTrue(token.waitForExistence(timeout: 10))
    token.tap()
    token.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_TOKEN"] ?? "")

    app.buttons["connection-test"].tap()

    // The pairing is now stored, and iOS offers to save the typed token into Passwords for
    // reuse. The token belongs to this app's keychain alone, so the offer is declined
    // whenever the system rises it.
    dismissCredentialOffer(in: app)
  }

  /// Declines the system's offer to save the typed token into Passwords. The offer is a sheet
  /// from another process, so it is absent from the app's own tree and from `app.sheets`, and
  /// it swallows every tap behind it — including taps a journey makes 3x down the screen.
  /// It also rises late, which is why this waits rather than asking once.
  private func dismissCredentialOffer(in app: XCUIApplication) {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let candidates = [
      springboard.buttons["Not Now"].firstMatch,
      app.buttons["Not Now"].firstMatch,
    ]
    let deadline = Date().addingTimeInterval(6)
    while Date() < deadline {
      for candidate in candidates where candidate.exists {
        candidate.tap()
        return
      }
      usleep(250_000)
    }
  }

  /// Filing is the one action the app takes on the library, and the design promises a naming
  /// step after it: "Title and tags come next." This proves that step arrives, and that it can
  /// be left without naming anything.
  func testFilingALinkOpensTheNamingStep() throws {
    let app = try launch()
    connect(app)

    // Filing lives in a sheet behind the toolbar's +, so the Library stays the collection.
    let file = app.buttons["library-file"]
    XCTAssertTrue(
      file.waitForExistence(timeout: 60),
      "the Library must offer File a set\n\(app.debugDescription)"
    )
    file.tap()
    let link = app.textFields["Paste a link"]
    XCTAssertTrue(
      link.waitForExistence(timeout: 15),
      "File a set must open with the paste field\n\(app.debugDescription)"
    )
    tapAtCentre(of: link, in: app)
    link.typeText("https://youtu.be/tPEMP9oYxTo")
    capture("07-link-pasted")

    app.buttons["File it"].tap()

    let title = app.textFields["reveal-title"]
    XCTAssertTrue(
      title.waitForExistence(timeout: 60),
      "filing must open the step where the Set is named\n\(app.debugDescription)"
    )
    XCTAssertTrue(app.buttons["reveal-done"].exists, "the naming step must offer Done")
    let chosen = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Press Return to add")
    ).firstMatch
    XCTAssertTrue(chosen.exists, "the naming step must offer Tags\n\(app.debugDescription)")
    capture("08-naming-step")

    app.buttons["reveal-dismiss"].tap()

    let confirmation = app.staticTexts["file-confirmation"]
    XCTAssertTrue(
      confirmation.waitForExistence(timeout: 30),
      "leaving the naming step must say what was filed\n\(app.debugDescription)"
    )
    capture("09-filed")
  }

  /// The Set page is where a Set is corrected or thrown away, so the journey walks the two
  /// actions that change the library, and the confirmation that guards the second one.
  func testOpensASetRenamesItAndRemovesIt() throws {
    let app = try launch()
    connect(app)

    let row = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
    XCTAssertTrue(
      row.waitForExistence(timeout: 60),
      "a saved Set must appear after connecting\n\(app.debugDescription)"
    )
    row.tap()

    let title = app.staticTexts["detail-title"]
    XCTAssertTrue(
      title.waitForExistence(timeout: 30),
      "pressing a row must open the Set's page\n\(app.debugDescription)"
    )
    XCTAssertTrue(app.buttons["detail-open"].exists, "the page must offer Open")
    capture("10-set-page")

    app.buttons["detail-title-row"].tap()
    let field = app.alerts.textFields.firstMatch
    XCTAssertTrue(
      field.waitForExistence(timeout: 15),
      "renaming must offer a field\n\(app.debugDescription)"
    )
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 24))
    field.typeText("Renamed by the journey")
    app.alerts.buttons["Save"].tap()

    XCTAssertTrue(
      app.staticTexts["Renamed by the journey"].waitForExistence(timeout: 30),
      "the page must show the name the service accepted\n\(app.debugDescription)"
    )
    capture("11-set-renamed")

    // Removal asks first. On iOS 26 the confirmation rises as a popover with no cancel
    // button, so it is dismissed the way a person dismisses one: by tapping outside it.
    app.buttons["detail-remove"].tap()
    XCTAssertTrue(
      app.sheets.firstMatch.waitForExistence(timeout: 10),
      "removing must ask first\n\(app.debugDescription)"
    )
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
    XCTAssertTrue(app.staticTexts["detail-title"].exists, "dismissing must keep the Set")

    app.buttons["detail-remove"].tap()
    confirmationButton("Remove from library", in: app).tap()

    // The page closes because the Set it was showing is gone, and the row goes with it.
    XCTAssertFalse(
      app.staticTexts["detail-title"].waitForExistence(timeout: 10),
      "removing must close the page\n\(app.debugDescription)"
    )
    let gone = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "Renamed by the journey")).firstMatch
    XCTAssertFalse(
      gone.waitForExistence(timeout: 5),
      "the removed Set must leave the library\n\(app.debugDescription)"
    )
    capture("12-set-removed")
  }

  /// A confirmation dialog is a sheet on a phone and an alert on a Mac, so a journey asks for
  /// both rather than assuming one shape. Each is waited for, because a dialog that is still
  /// rising has not been found yet.
  private func confirmationButton(_ label: String, in app: XCUIApplication) -> XCUIElement {
    let sheet = app.sheets.buttons[label]
    if sheet.waitForExistence(timeout: 5) {
      return sheet
    }
    let alert = app.alerts.buttons[label]
    if alert.waitForExistence(timeout: 5) {
      return alert
    }
    return app.buttons[label]
  }

  /// The design names the active filter in its heading, and the pill is the only way to reach
  /// either state from the UI. A control that turns a filter off but never on looks alive while
  /// leaving the Library unfilterable, so both directions are tapped.
  func testFiltersTheLibraryByTag() throws {
    let app = try launch()
    connect(app)

    let pill = app.descendants(matching: .any)["tag-filter-techno"]
    XCTAssertTrue(
      pill.waitForExistence(timeout: 60),
      "the tag filter must appear above the rows\n\(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["Everything"].exists, "the Library must open unfiltered")

    tapAtCentre(of: pill, in: app)
    XCTAssertTrue(
      app.staticTexts["Everything / techno"].waitForExistence(timeout: 20),
      "pressing the pill must turn the filter on\n\(app.debugDescription)")
    XCTAssertTrue(
      app.descendants(matching: .any)
        .matching(NSPredicate(format: "label CONTAINS %@", "outside this filter")).firstMatch
        .exists,
      "a filtered Library must report what it hides")
    capture("06-library-filtered")

    tapAtCentre(of: pill, in: app)
    XCTAssertTrue(
      app.staticTexts["Everything"].waitForExistence(timeout: 20),
      "pressing the same pill must clear the filter\n\(app.debugDescription)")
    XCTAssertFalse(
      app.staticTexts["Everything / techno"].exists, "the heading must stop naming the filter")
  }

  /// A Set found by search is the reason to search, so the result has to open. The Library row
  /// in the same component opens the same page, on the same build, in the same pass.
  func testOpensASetFromASearchResult() throws {
    let app = try launch()
    connect(app)

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
    result.tap()

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
    let app = try launch()
    connect(app)

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
    connect(app)

    XCTAssertTrue(
      app.staticTexts["Everything / hardgroove"].waitForExistence(timeout: 60),
      "the screen must name the filter it is showing\n\(app.debugDescription)")
    XCTAssertTrue(
      noResults(in: app).exists,
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

  func testUnreachableAddressNamesTheRecoveryAction() throws {
    let app = try launch()

    let address = app.textFields["connection-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 30))
    address.tap()
    address.typeText("http://127.0.0.1:1")

    let token = app.secureTextFields["connection-token"]
    token.tap()
    token.typeText("not-a-real-token")

    app.buttons["connection-test"].tap()

    let error = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Cannot reach your library")
    ).firstMatch
    XCTAssertTrue(
      error.waitForExistence(timeout: 60), "an unreachable address must explain itself\n\(app.debugDescription)")
    XCTAssertTrue(
      app.buttons["copy-failure"].exists,
      "a failure must offer its details to copy\n\(app.debugDescription)"
    )
    capture("05-connection-error")
  }
}
