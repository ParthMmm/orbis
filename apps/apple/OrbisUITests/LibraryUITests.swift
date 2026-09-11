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

  /// Search is a tab on a compact width class and a sidebar item on a regular one, so the
  /// journey proves the platform's navigation rather than assuming one shape.
  private func openSearch(in app: XCUIApplication) {
    let tab = app.tabBars.buttons["Search"]
    if tab.waitForExistence(timeout: 8) {
      tab.tap()
      return
    }
    let sidebarSearch = app.buttons["sidebar-search"]
    XCTAssertTrue(
      sidebarSearch.waitForExistence(timeout: 15),
      "Search must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    sidebarSearch.tap()
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

    openSearch(in: app)
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 30), "the Search destination must offer a field")
    field.tap()
    field.typeText("night")
    field.typeText("\n")
    XCTAssertTrue(row.waitForExistence(timeout: 30), "search must find the Set")
    capture("03-search-results")

    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
    field.typeText("zzzznothing")
    field.typeText("\n")
    let noResults = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "No matching sets")).firstMatch
    XCTAssertTrue(noResults.waitForExistence(timeout: 30), "an unmatched search must say so\n\(app.debugDescription)")
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
    let notNow = app.sheets.buttons["Not Now"].firstMatch
    if notNow.waitForExistence(timeout: 5) {
      notNow.tap()
    }
  }

  /// Filing is the one action the app takes on the library, and the design promises a naming
  /// step after it: "Title and tags come next." This proves that step arrives, and that it can
  /// be left without naming anything.
  func testFilingALinkOpensTheNamingStep() throws {
    let app = try launch()
    connect(app)

    let link = app.textFields["Paste a link"]
    XCTAssertTrue(
      link.waitForExistence(timeout: 60),
      "the Library must open with the paste field\n\(app.debugDescription)"
    )
    link.tap()
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

  /// The design names the active filter in its heading, which is the state that distinguishes
  /// a filtered list from an unfiltered one.
  func testFiltersTheLibraryByTag() throws {
    let app = try launch(filteringBy: "techno")
    connect(app)

    let footer = app.staticTexts
      .matching(NSPredicate(format: "label CONTAINS %@", "outside this filter")).firstMatch
    XCTAssertTrue(
      footer.waitForExistence(timeout: 60), "a filtered Library must report what it hides\n\(app.debugDescription)")

    let filter = app.descendants(matching: .any)["tag-filter-techno"]
    XCTAssertTrue(filter.exists, "the tag filter must appear above the rows\n\(app.debugDescription)")
    capture("06-library-filtered")
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
