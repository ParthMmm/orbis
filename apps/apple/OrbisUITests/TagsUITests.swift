import XCTest

/// Tags as the quick way to organise the Library: combining them in a filter, putting one on
/// several Sets at once, and finding one by typing part of its name. Each journey files Sets
/// with Tags of its own, so the lane's shared library cannot decide its outcome.
final class TagsUITests: LibraryJourney {
  private func row(_ set: LaneService.Set, in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)["set-row-\(set.id)"]
  }

  func testCombiningTwoTagsNarrowsTheLibraryToSetsCarryingBoth() throws {
    let service = try LaneService()
    let both = try service.saveSet(
      title: "Dub on the roof", url: "https://www.youtube.com/watch?v=tagscombo01",
      tags: ["dub", "rooftop"])
    let dubOnly = try service.saveSet(
      title: "Dub in the basement", url: "https://www.youtube.com/watch?v=tagscombo02",
      tags: ["dub"])
    let roofOnly = try service.saveSet(
      title: "Rooftop house", url: "https://www.youtube.com/watch?v=tagscombo03",
      tags: ["rooftop"])
    let app = try launch()
    openLibrary(in: app)

    let dub = app.buttons["tag-filter-dub"]
    let rooftop = app.buttons["tag-filter-rooftop"]
    XCTAssertTrue(
      dub.waitForExistence(timeout: 60), "the Tag must appear above the rows\n\(app.debugDescription)")
    tapAtCentre(of: dub, in: app)
    XCTAssertTrue(
      row(dubOnly, in: app).waitForExistence(timeout: 15), "one Tag admits every Set carrying it")
    XCTAssertTrue(rooftop.waitForExistence(timeout: 5))
    tapAtCentre(of: rooftop, in: app)

    let footer = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "1 set tagged dub and rooftop")).firstMatch
    XCTAssertTrue(
      footer.waitForExistence(timeout: 20),
      "the footer must name both Tags\n\(app.debugDescription)")
    XCTAssertTrue(dub.isSelected, "the first Tag stays on")
    XCTAssertTrue(rooftop.isSelected, "the second Tag joins it")
    XCTAssertTrue(row(both, in: app).exists, "the Set carrying both stays")
    XCTAssertFalse(row(dubOnly, in: app).exists, "a Set missing the second Tag leaves")
    XCTAssertFalse(row(roofOnly, in: app).exists, "a Set missing the first Tag leaves")
    capture("tags-combined-filter")
  }

  func testTaggingTwoSetsAtOnceReachesTheService() throws {
    let service = try LaneService()
    let first = try service.saveSet(
      title: "Bulk first", url: "https://www.youtube.com/watch?v=tagsbulk001")
    let second = try service.saveSet(
      title: "Bulk second", url: "https://www.youtube.com/watch?v=tagsbulk002")
    _ = try service.saveSet(
      title: "Already in the crate", url: "https://www.youtube.com/watch?v=tagsbulk003",
      tags: ["crate"])
    let app = try launch()
    openLibrary(in: app)

    let more = app.buttons["library-more"]
    XCTAssertTrue(
      more.waitForExistence(timeout: 60), "the Library must offer More\n\(app.debugDescription)")
    XCTAssertTrue(row(first, in: app).waitForExistence(timeout: 30))
    more.tap()
    let select = app.buttons["library-select"]
    XCTAssertTrue(
      select.waitForExistence(timeout: 10), "More must offer Select\n\(app.debugDescription)")
    select.tap()
    let tag = app.buttons["library-bulk-tag"]
    XCTAssertTrue(tag.waitForExistence(timeout: 10), "selection mode must show its bar")
    XCTAssertFalse(tag.isEnabled, "Tag waits for a pick")

    tapAtCentre(of: row(first, in: app), in: app)
    tapAtCentre(of: row(second, in: app), in: app)
    let count = app.staticTexts["library-selection-count"]
    XCTAssertTrue(
      count.waitForExistence(timeout: 5) && count.label == "2 selected",
      "two taps pick two Sets\n\(app.debugDescription)")
    XCTAssertFalse(
      app.staticTexts["detail-title"].exists, "a tap in selection mode must not open the Set")
    capture("tags-two-selected")

    tag.tap()
    let crate = app.buttons["bulk-tag-crate"]
    XCTAssertTrue(
      crate.waitForExistence(timeout: 10), "the sheet must list the Tags\n\(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["Tag 2 Sets"].exists, "the sheet names how many Sets it tags")
    crate.tap()
    XCTAssertTrue(
      waitUntil(timeout: 15) { crate.isSelected },
      "a Tag every picked Set now carries shows as on\n\(app.debugDescription)")
    capture("tags-bulk-sheet")

    var stored: [String: [String]] = [:]
    XCTAssertTrue(
      waitUntil(timeout: 15) {
        let sets = (try? service.library()) ?? []
        stored = Dictionary(
          uniqueKeysWithValues: sets.filter { [first.id, second.id].contains($0.id) }
            .map { ($0.id, $0.tags) })
        return stored[first.id]?.contains("crate") == true
          && stored[second.id]?.contains("crate") == true
      },
      "the service must hold the Tag on both Sets, and holds \(stored)")
    try record("tags-bulk-service", ["sets": stored])

    app.buttons["bulk-tag-done"].tap()
    app.buttons["library-select-done"].tap()
    XCTAssertTrue(
      more.waitForExistence(timeout: 10), "Done leaves selection mode\n\(app.debugDescription)")
  }

  func testTypingAPrefixOffersTheMatchingTagAndANewOne() throws {
    let service = try LaneService()
    let edited = try service.saveSet(
      title: "Prefix target", url: "https://www.youtube.com/watch?v=tagsprefix1")
    _ = try service.saveSet(
      title: "Prefix source", url: "https://www.youtube.com/watch?v=tagsprefix2",
      tags: ["vinylcut"])
    let app = try launch()
    openLibrary(in: app)

    let target = row(edited, in: app)
    XCTAssertTrue(target.waitForExistence(timeout: 60), "the filed Set must appear")
    tapAtCentre(of: target, in: app)
    XCTAssertTrue(app.staticTexts["detail-title"].waitForExistence(timeout: 15))
    app.buttons["detail-actions"].tap()
    let edit = app.buttons["detail-edit-tags"]
    XCTAssertTrue(edit.waitForExistence(timeout: 5), "the menu must offer the Tags")
    edit.tap()

    let field = app.textFields["tag-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 15), "the editor must offer a field")
    field.tap()
    field.typeText("viny")
    XCTAssertTrue(
      app.buttons["tag-suggestion-vinylcut"].waitForExistence(timeout: 10),
      "a prefix must offer the Tag it starts\n\(app.debugDescription)")
    let create = app.buttons["tag-create"]
    XCTAssertTrue(create.exists, "a draft no Tag is named must be offered as a new Tag")
    XCTAssertTrue(create.label.contains("Create \"viny\""), "the new Tag chip names the draft")
    capture("tags-type-ahead")

    field.typeText("\n")
    XCTAssertTrue(
      app.buttons["tag-remove-vinylcut"].waitForExistence(timeout: 10),
      "Return takes the Tag the prefix starts rather than making one\n\(app.debugDescription)")
    XCTAssertFalse(app.buttons["tag-remove-viny"].exists, "Return must not make the draft a Tag")
    app.buttons["tags-cancel"].tap()
  }

  private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if condition() { return true }
      usleep(250_000)
    } while Date() < deadline
    return condition()
  }
}
