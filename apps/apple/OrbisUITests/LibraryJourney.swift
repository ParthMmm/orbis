import XCTest

/// What every Library journey shares: launching against the lane service, moving between
/// tabs, searching, and capturing evidence. The journeys themselves live in small classes by
/// area, because Xcode hands a whole class to one simulator, and one large class kept every
/// other simulator idle.
class LibraryJourney: XCTestCase {
  func launch(filteringBy tag: String? = nil) throws -> XCUIApplication {
    let service = try LaneService()
    return launchOrbis(
      address: service.address, token: service.token,
      arguments: tag.map { ["-orbisStartTagFiltered", $0] } ?? [])
  }

  func record(_ name: String, _ values: [String: Any]) throws {
    let data = try JSONSerialization.data(
      withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Taps the centre of an element's own frame, with the point taken from the window. XCUITest
  /// reports a hit point of `{-1, -1}` for some controls inside the Library's scroll view — it
  /// decides the element is not visible, tries to scroll it into view, and gives up — while the
  /// same element reports `hittable` in the accessibility tree and responds to a tap at the point
  /// its own frame names. The point is measured from the window rather than from the element's
  /// coordinate space, which is the difference that makes the tap land.
  func tapAtCentre(of element: XCUIElement, in app: XCUIApplication) {
    let frame = element.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      .tap()
  }

  @discardableResult
  func openSearch(in app: XCUIApplication) -> XCUICoordinate? {
    let tab = app.tabBars.buttons["Search"]
    if tab.waitForExistence(timeout: 8) {
      tab.tap()
      XCTAssertTrue(
        app.searchFields.firstMatch.waitForExistence(timeout: 15),
        "Search must show its field at the top\n\(app.debugDescription)")
      tab.tap()
      XCTAssertTrue(
        app.keyboards.firstMatch.waitForExistence(timeout: 15),
        "a second tap on Search must focus the field\n\(app.debugDescription)")
      return nil
    }
    let sidebarSearch = app.buttons["sidebar-search"]
    XCTAssertTrue(
      sidebarSearch.waitForExistence(timeout: 15),
      "Search must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    sidebarSearch.tap()
    return nil
  }

  func openLibrary(in app: XCUIApplication) {
    selectTab("Library", in: app, sidebarIdentifier: "sidebar-library")
  }

  /// Taps the tab's symbol, then waits until that tab's navigation bar is showing. The centre
  /// of the button's frame falls on the list under the floating bar, so the previous tab stays
  /// selected. `tap()` on the button itself reports a hit point of `{-1, -1}`.
  func selectTab(_ name: String, in app: XCUIApplication, sidebarIdentifier: String) {
    let tab = app.tabBars.buttons[name]
    if tab.waitForExistence(timeout: 8) {
      let deadline = Date().addingTimeInterval(12)
      while Date() < deadline {
        if app.navigationBars[name].exists { return }
        let frame = tab.frame
        guard frame.width > 40, frame.minY > 600 else {
          usleep(200_000)
          continue
        }
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
          .withOffset(CGVector(dx: frame.midX, dy: frame.minY + 18))
          .tap()
        if app.navigationBars[name].waitForExistence(timeout: 2) { return }
      }
      XCTFail("\(name) must open from its tab\n\(app.debugDescription)")
      return
    }
    let sidebar = app.buttons[sidebarIdentifier]
    XCTAssertTrue(
      sidebar.waitForExistence(timeout: 15),
      "\(name) must be reachable from a tab bar or the sidebar\n\(app.debugDescription)"
    )
    sidebar.tap()
  }

  /// The prompt the field shows while it is empty. XCUITest reports it as the field's value.
  static let searchPrompt = "Title, tag, or source link"

  func searchText(in app: XCUIApplication) -> String {
    let value = (app.searchFields.firstMatch.value as? String) ?? ""
    return value == Self.searchPrompt ? "" : value
  }

  /// Focuses the field. It replaces the tab button once the tab is selected, and XCUITest
  /// cannot address it after the morph settles, so the first focus uses the point the button
  /// occupied and a later one uses the bar's centre, where a query narrows the field to.
  func focusSearch(in app: XCUIApplication, spot: XCUICoordinate?) {
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

  func submitSearch(_ query: String, in app: XCUIApplication, spot: XCUICoordinate?) {
    focusSearch(in: app, spot: spot)
    let existing = searchText(in: app)
    if !existing.isEmpty {
      app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    app.typeText(query)
    app.typeText("\n")
  }

  func noResults(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "No matching sets")).firstMatch
  }

  func untouchedSearch(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Search your")).firstMatch
  }

  func confirmationButton(_ label: String, in app: XCUIApplication) -> XCUIElement {
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
}
