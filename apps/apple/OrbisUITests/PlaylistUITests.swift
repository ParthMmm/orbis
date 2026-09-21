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
  }

  private func openPlaylists(in app: XCUIApplication) {
    let tab = app.tabBars.buttons["Playlists"]
    if tab.waitForExistence(timeout: 8) {
      tab.tap()
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
    app.buttons["playlist-create"].tap()
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
    let add = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "playlist-add-")
    ).firstMatch
    XCTAssertTrue(
      add.waitForExistence(timeout: 30),
      "the library must offer Sets to add\n\(app.debugDescription)"
    )
    add.tap()

    XCTAssertTrue(
      app.descendants(matching: .any)
        .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
        .waitForExistence(timeout: 30),
      "the added Set must appear in playlist order\n\(app.debugDescription)"
    )
    capture("playlist-add-sets")

    let member = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@", "playlist-member-")).firstMatch
    XCTAssertTrue(member.exists)
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
    let libraryTab = app.tabBars.buttons["Library"]
    if libraryTab.waitForExistence(timeout: 5) {
      libraryTab.tap()
    } else {
      app.buttons["sidebar-library"].tap()
    }
    XCTAssertTrue(
      app.descendants(matching: .any)
        .matching(NSPredicate(format: "label CONTAINS %@", "Night session")).firstMatch
        .waitForExistence(timeout: 30),
      "the Set must remain in the Library after playlist removal\n\(app.debugDescription)"
    )
  }
}
