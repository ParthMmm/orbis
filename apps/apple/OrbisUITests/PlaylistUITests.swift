import XCTest

/// Drives Playlist authoring against the lane service: create, add membership, remove, and
/// confirm the Set remains in the Library.
final class PlaylistUITests: XCTestCase {
  private func launch() throws -> XCUIApplication {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    let app = XCUIApplication()
    app.launchArguments.append("-orbisResetSettings")
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

  private func connect(_ app: XCUIApplication) {
    let address = app.textFields["connection-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 30))
    address.tap()
    address.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_ADDRESS"] ?? "")
    let token = app.secureTextFields["connection-token"]
    token.tap()
    token.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_TOKEN"] ?? "")
    app.buttons["connection-test"].tap()
    dismissCredentialOffer(in: app)
  }

  /// Declines the system's offer to save the typed token. The sheet belongs to SpringBoard,
  /// so it is absent from this app's tree and swallows the next tap.
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

  /// Same symbol tap as `LibraryUITests.selectTab`.
  private func selectTab(_ name: String, in app: XCUIApplication) {
    let tab = app.tabBars.buttons[name]
    XCTAssertTrue(tab.waitForExistence(timeout: 8), "\(name) must be a tab\n\(app.debugDescription)")
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
  }

  private func openPlaylists(in app: XCUIApplication) {
    if app.tabBars.buttons["Playlists"].waitForExistence(timeout: 8) {
      selectTab("Playlists", in: app)
      return
    }
    let sidebar = app.buttons["sidebar-playlists"]
    XCTAssertTrue(
      sidebar.waitForExistence(timeout: 15),
      "Playlists must be reachable from a tab or the sidebar\n\(app.debugDescription)"
    )
    sidebar.tap()
  }

  func testCreatesAddsRemovesAndPreservesTheSet() throws {
    let app = try launch()
    connect(app)

    openPlaylists(in: app)
    let create = app.buttons["playlist-create"]
    XCTAssertTrue(
      create.waitForExistence(timeout: 15),
      "Playlists must offer a way to create one\n\(app.debugDescription)"
    )
    create.tap()
    let nameField = app.textFields["playlist-name"]
    XCTAssertTrue(
      nameField.waitForExistence(timeout: 15),
      "creating a playlist must offer a name field\n\(app.debugDescription)"
    )
    nameField.tap()
    nameField.typeText("Evenings")
    app.buttons["playlist-create-save"].tap()
    capture("playlist-created")

    XCTAssertTrue(
      app.buttons["playlist-add-sets"].waitForExistence(timeout: 30),
      "a new playlist must open for membership\n\(app.debugDescription)"
    )
    app.buttons["playlist-add-sets"].tap()
    // playlist-add-sets is the toolbar button that opened this sheet. The row that adds one
    // Set is playlist-add-<id>, and firstMatch would otherwise press the toolbar again.
    let add = app.buttons.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND identifier != %@", "playlist-add-", "playlist-add-sets")
    ).firstMatch
    XCTAssertTrue(
      add.waitForExistence(timeout: 30),
      "the library must offer Sets to add\n\(app.debugDescription)"
    )
    let title = add.label
    add.tap()

    let member = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "playlist-member-")).firstMatch
    XCTAssertTrue(
      member.waitForExistence(timeout: 30),
      "the added Set must appear in playlist order\n\(app.debugDescription)"
    )
    capture("playlist-add-sets")

    member.swipeLeft()
    let remove = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "playlist-remove-")
    ).firstMatch
    if remove.waitForExistence(timeout: 5) {
      remove.tap()
    } else {
      app.buttons["Remove"].tap()
    }

    XCTAssertTrue(
      app.staticTexts["This Playlist is empty"].waitForExistence(timeout: 30),
      "removing membership must empty the playlist, not the library\n\(app.debugDescription)"
    )
    capture("playlist-removal-preserves-set")

    app.buttons["playlist-back"].tap()
    if app.tabBars.buttons["Library"].waitForExistence(timeout: 5) {
      selectTab("Library", in: app)
    } else {
      app.buttons["sidebar-library"].tap()
    }
    XCTAssertTrue(
      app.descendants(matching: .any)
        .matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        .waitForExistence(timeout: 30),
      "the Set must remain in the Library after playlist removal\n\(app.debugDescription)"
    )
  }
}
