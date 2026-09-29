import XCTest

/// Drives Playlist authoring against the lane service: create, add membership, remove, and
/// confirm the Set remains in the Library.
final class PlaylistUITests: XCTestCase {
  private func launch(paired: Bool = false) throws -> XCUIApplication {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
      let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
    else {
      throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
    }
    let app = XCUIApplication()
    app.launchArguments.append("-orbisResetSettings")
    if paired {
      app.launchArguments.append(contentsOf: ["-orbisPairedWith", address, token])
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

  private func tapAtCentre(of element: XCUIElement, in app: XCUIApplication) {
    let frame = element.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      .tap()
  }

  /// A name no earlier journey or run has used, since every journey shares the lane's service.
  private func unique(_ prefix: String) -> String {
    "\(prefix) \(UUID().uuidString.prefix(6))"
  }

  private func youtubeURL() -> String {
    let letters = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    return "https://www.youtube.com/watch?v=" + String((0..<11).map { _ in letters.randomElement()! })
  }

  /// Waits until the service stores the expected order, and returns what it last read.
  private func storedOrder(
    of playlistId: String, in service: LaneService, becomes expected: [String]
  ) throws -> [String] {
    var stored: [String] = []
    let deadline = Date().addingTimeInterval(20)
    repeat {
      stored = try service.members(of: playlistId).map(\.id)
      if stored == expected { return stored }
      usleep(500_000)
    } while Date() < deadline
    return stored
  }

  /// The run's record: each step with the order it expected and the order the service stored.
  /// It is written as JSON beside the screenshots, so a later run can be compared against it.
  private func record(_ name: String, _ steps: [[String: Any]]) throws {
    let data = try JSONSerialization.data(
      withJSONObject: ["journey": name, "steps": steps], options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func openPlaylist(named name: String, in app: XCUIApplication) {
    openPlaylists(in: app)
    let row = app.descendants(matching: .any)["playlist-row-\(name)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 30), "the seeded playlist must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)
  }

  func testNoPlaylistsInvitesCreation() throws {
    let service = try LaneService()
    for playlist in try service.playlists() {
      try service.deletePlaylist(playlist.id)
    }

    let app = try launch(paired: true)
    openPlaylists(in: app)
    let empty = app.descendants(matching: .any)["playlists-empty"]
    XCTAssertTrue(empty.waitForExistence(timeout: 30), "the empty list must keep its identifier")
    XCTAssertTrue(app.staticTexts["No playlists yet"].exists)
    XCTAssertTrue(app.staticTexts["Create a playlist to organize your Sets."].exists)
    let create = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "playlists-empty", "New playlist")
    ).firstMatch
    XCTAssertTrue(create.exists, "the empty state must name the create action")
    capture("playlists-empty")

    create.tap()
    XCTAssertTrue(app.textFields["playlist-name"].waitForExistence(timeout: 15))
    app.textFields["playlist-name"].tap()
    app.textFields["playlist-name"].typeText(unique("Empty"))
    app.buttons["playlist-create-save"].tap()
    XCTAssertTrue(
      app.staticTexts["This Playlist is empty"].waitForExistence(timeout: 30),
      "a playlist without Sets must keep its own empty state"
    )
    capture("playlist-empty-after-create")
  }

  /// Reordering and removal both rewrite the whole member list, so a one-member playlist cannot
  /// show a wrong order or a wrong Set removed. Three members can.
  func testReordersAndRemovesMembersOfAPlaylist() throws {
    let service = try LaneService()
    let sets = try ["First", "Second", "Third"].map {
      try service.saveSet(title: unique($0), url: youtubeURL())
    }
    let playlist = try service.createPlaylist(named: unique("Order"))
    try service.setMembers(of: playlist.id, to: sets.map(\.id))
    let (first, second, third) = (sets[0], sets[1], sets[2])
    var steps: [[String: Any]] = []

    let app = try launch(paired: true)
    openPlaylist(named: playlist.name, in: app)
    let rows = sets.map { app.descendants(matching: .any)["playlist-member-\($0.id)"] }
    for row in rows {
      XCTAssertTrue(
        row.waitForExistence(timeout: 30), "every member must be listed\n\(app.debugDescription)")
    }
    capture("playlist-order-seeded")

    app.buttons["playlist-edit"].tap()
    let handles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reorder"))
    XCTAssertTrue(
      handles.element(boundBy: 2).waitForExistence(timeout: 10),
      "editing must offer a reorder handle on each member\n\(app.debugDescription)")
    handles.element(boundBy: 2).press(forDuration: 0.6, thenDragTo: handles.element(boundBy: 0))
    let moved = [third.id, first.id, second.id]
    let afterMove = try storedOrder(of: playlist.id, in: service, becomes: moved)
    steps.append(["step": "move third to top", "expected": moved, "stored": afterMove])
    XCTAssertEqual(afterMove, moved, "the service must store the order the drag made")
    app.buttons["playlist-edit"].tap()
    capture("playlist-order-moved")

    rows[0].swipeLeft()
    let remove = app.buttons["playlist-remove-\(first.id)"]
    XCTAssertTrue(
      remove.waitForExistence(timeout: 10), "a swipe must offer Remove\n\(app.debugDescription)")
    remove.tap()
    let kept = [third.id, second.id]
    let afterRemove = try storedOrder(of: playlist.id, in: service, becomes: kept)
    steps.append(["step": "remove first", "expected": kept, "stored": afterRemove])
    XCTAssertEqual(afterRemove, kept, "removal must drop only that Set and keep the others' order")
    XCTAssertFalse(rows[0].waitForExistence(timeout: 5), "the removed row must leave the playlist")
    XCTAssertLessThan(
      rows[2].frame.minY, rows[1].frame.minY, "the screen must show the order the service stored")
    capture("playlist-order-removed")

    let library = try service.library().map(\.id)
    steps.append(["step": "removed Set stays in the Library", "stored": library.contains(first.id)])
    XCTAssertTrue(library.contains(first.id), "leaving a playlist must not remove the Set")
    try record("playlist-order", steps)
  }

  /// The Set page's More menu is the other way into a playlist. Each tab keeps its own opened
  /// Set, so the page opened here must not follow the person to Home.
  func testAddsASetToAPlaylistFromItsPage() throws {
    let service = try LaneService()
    let set = try service.saveSet(title: unique("Page"), url: youtubeURL())
    let playlist = try service.createPlaylist(named: unique("From page"))
    var steps: [[String: Any]] = []

    let app = try launch(paired: true)
    selectTab("Library", in: app)
    let row = app.descendants(matching: .any)["set-row-\(set.id)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 30), "the seeded Set must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)
    XCTAssertTrue(
      app.staticTexts["detail-title"].waitForExistence(timeout: 30),
      "pressing a row must open the Set's page\n\(app.debugDescription)")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-playlist"].tap()
    // Once joined, the playlist is listed under Recents and All Playlists alike.
    let choice = app.buttons.matching(identifier: "add-to-playlist-\(playlist.name)").firstMatch
    XCTAssertTrue(
      choice.waitForExistence(timeout: 15),
      "the sheet must list every playlist\n\(app.debugDescription)")
    capture("add-to-playlist-sheet")
    choice.tap()
    XCTAssertFalse(choice.waitForExistence(timeout: 5), "choosing a playlist must close the sheet")
    let stored = try storedOrder(of: playlist.id, in: service, becomes: [set.id])
    steps.append(["step": "add from the Set page", "expected": [set.id], "stored": stored])
    XCTAssertEqual(stored, [set.id], "the service must store the membership")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-playlist"].tap()
    XCTAssertTrue(choice.waitForExistence(timeout: 15))
    XCTAssertEqual(choice.value as? String, "Added", "the sheet must mark the playlist it joined")
    capture("add-to-playlist-added")
    app.buttons["Close"].tap()

    selectTab("Home", in: app)
    let leaked = app.staticTexts["detail-title"].waitForExistence(timeout: 3)
    steps.append(["step": "Home shows its own page", "setPageOnHome": leaked])
    XCTAssertFalse(leaked, "a Set opened in the Library must not show on Home")
    // One tap: a second on the selected tab pops it to its root, which selectTab would do
    // while it waits for a Library title the Set page covers.
    let library = app.tabBars.buttons["Library"].frame
    app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: library.midX, dy: library.minY + 18))
      .tap()
    XCTAssertTrue(
      app.staticTexts["detail-title"].waitForExistence(timeout: 10),
      "returning to the Library must keep its opened Set")
    try record("add-to-playlist", steps)
  }

  func testCreatesAddsRemovesAndPreservesTheSet() throws {
    let app = try launch(paired: true)

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
