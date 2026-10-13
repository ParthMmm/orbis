import XCTest

/// Filing a Set and managing it from its page.
final class SetPageUITests: LibraryJourney {
  /// Filing is the one action the app takes on the library, and the design promises a naming
  /// step after it: "Title and tags come next." This proves that step arrives, and that it can
  /// be left without naming anything.
  func testFilingALinkOpensTheNamingStep() throws {
    let app = try launch(paired: true)
    openLibrary(in: app)

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

    // Wait for the pasted link to enable filing, then wait for the naming controls.
    // The Tag field's identifier keeps its lookup independent of the footer copy.
    let fileIt = app.buttons["File it"]
    let enabled = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND enabled == true"), object: fileIt)
    XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 15), .completed, "a pasted link must enable File it")
    fileIt.tap()

    let title = app.textFields["reveal-title"]
    XCTAssertTrue(
      title.waitForExistence(timeout: 60),
      "filing must open the step where the Set is named\n\(app.debugDescription)"
    )
    let dismiss = app.buttons["reveal-dismiss"]
    XCTAssertTrue(app.buttons["reveal-done"].waitForExistence(timeout: 15), "the naming step must offer Done")
    XCTAssertTrue(dismiss.waitForExistence(timeout: 15), "the naming step must offer Not Now")
    XCTAssertTrue(
      app.textFields["tag-field"].waitForExistence(timeout: 15),
      "the naming step must offer Tags\n\(app.debugDescription)"
    )
    capture("08-naming-step")

    dismiss.tap()

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
    // Its own Set, because removing the lane's seeded one would take it from other journeys.
    let seeded = try LaneService().saveSet(
      title: "Set to rename", url: "https://www.youtube.com/watch?v=renameme001")
    let app = try launch(paired: true)
    openLibrary(in: app)

    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 60),
      "a saved Set must appear after connecting\n\(app.debugDescription)"
    )
    tapAtCentre(of: row, in: app)

    let title = app.staticTexts["detail-title"]
    XCTAssertTrue(
      title.waitForExistence(timeout: 30),
      "pressing a row must open the Set's page\n\(app.debugDescription)"
    )
    XCTAssertTrue(app.buttons["detail-open"].exists, "the page must offer the source")
    capture("10-set-page")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-rename-action"].tap()
    let field = app.textFields["rename-title"]
    XCTAssertTrue(
      field.waitForExistence(timeout: 15),
      "renaming must offer a field\n\(app.debugDescription)"
    )
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 24))
    field.typeText("Renamed by the journey")
    app.buttons["rename-save"].tap()

    XCTAssertTrue(
      app.staticTexts["Renamed by the journey"].waitForExistence(timeout: 30),
      "the page must show the name the service accepted\n\(app.debugDescription)"
    )
    capture("11-set-renamed")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-remove"].tap()
    XCTAssertTrue(
      app.sheets.firstMatch.waitForExistence(timeout: 10),
      "removing must ask first\n\(app.debugDescription)"
    )
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
    XCTAssertTrue(app.staticTexts["detail-title"].exists, "dismissing must keep the Set")

    app.buttons["detail-actions"].tap()
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
}
