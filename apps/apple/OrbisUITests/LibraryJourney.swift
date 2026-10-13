import XCTest

/// What every Library journey shares: launching against the lane service, moving between
/// tabs, searching, and capturing evidence. The journeys themselves live in small classes by
/// area, because Xcode hands a whole class to one simulator, and one large class kept every
/// other simulator idle.
class LibraryJourney: XCTestCase {
  /// `paired` starts the app already paired, for a journey that is not about the connection
  /// screen. Typing the address and token costs each journey several seconds.
  /// `serviceAddress` stands in for the built-in service address, so a fresh install signs in to
  /// the lane's service.
  func launch(
    paired: Bool = false, filteringBy tag: String? = nil, serviceAddress: String? = nil
  ) throws -> XCUIApplication {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    let app = XCUIApplication()
    app.launchArguments.append("-orbisResetSettings")
    app.launchArguments.append(contentsOf: ["-orbisServiceAddress", serviceAddress ?? address])
    if paired {
      app.launchArguments.append(contentsOf: ["-orbisPairedWith", address, token])
    }
    if let tag {
      app.launchArguments.append(contentsOf: ["-orbisStartTagFiltered", tag])
    }
    app.launchEnvironment["ORBIS_TEST_SETTINGS"] = "memory"
    app.launchEnvironment["ORBIS_UI_TEST_ADDRESS"] = address
    app.launchEnvironment["ORBIS_UI_TEST_TOKEN"] = token
    app.launch()
    return app
  }

  func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
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

  /// Search is a tab on a compact width class and a sidebar item on a regular one, so the
  /// journey proves the platform's navigation rather than assuming one shape.
  /// Returns the point the field sits at on iPhone, so a later query can focus it again once
  /// the button it replaced is gone.
  @discardableResult
  func openSearch(in app: XCUIApplication) -> XCUICoordinate? {
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

  /// Home is the first tab after pairing. The Library list, its filter, and File a set live on
  /// the Library tab, so a journey that wants them has to select it.
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

  /// What the field holds, with the prompt an empty field shows treated as nothing.
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

  /// Types a query and submits it. Whatever the field held is replaced, so one launch can
  /// search twice.
  func submitSearch(_ query: String, in app: XCUIApplication, spot: XCUICoordinate?) {
    focusSearch(in: app, spot: spot)
    let existing = searchText(in: app)
    if !existing.isEmpty {
      app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
    }
    app.typeText(query)
    app.typeText("\n")
  }

  /// The state an unmatched search shows, matched by its words rather than its shape.
  func noResults(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@", "No matching sets")).firstMatch
  }

  func untouchedSearch(in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Search your")).firstMatch
  }

  /// Signs the app in with a pasted key the way a person would, so a journey that begins after
  /// connecting does not restate the sign-in screen's details. The address is the built-in one.
  func connect(_ app: XCUIApplication) {
    let token = app.secureTextFields["connection-token"]
    XCTAssertTrue(token.waitForExistence(timeout: 30), "the sign-in screen must appear\n\(app.debugDescription)")
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
  func dismissCredentialOffer(in app: XCUIApplication) {
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

  /// A confirmation dialog is a sheet on a phone and an alert on a Mac, so a journey asks for
  /// both rather than assuming one shape. Each is waited for, because a dialog that is still
  /// rising has not been found yet.
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
