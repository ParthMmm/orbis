import XCTest

/// Adding a Set to a Playlist from its page, and the empty Playlists state.
final class PlaylistMembershipUITests: PlaylistJourney {
  /// The Set page's More menu is the other way into a playlist. Each tab keeps its own opened
  /// Set, so the page opened here must not follow the person to Home.
  func testAddsASetToAPlaylistFromItsPage() throws {
    let service = try LaneService()
    let set = try service.saveSet(title: unique("Page"), url: youtubeURL())
    let playlist = try service.createPlaylist(named: unique("From page"))
    let confusablePlaylist = try service.createPlaylist(named: "recent-\(playlist.name)")
    var steps: [[String: Any]] = []

    let app = try launch()
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
    let allChoices = app.buttons.matching(identifier: "add-to-playlist-all-\(playlist.id)")
    let recentChoices = app.buttons.matching(identifier: "add-to-playlist-recent-\(playlist.id)")
    let confusableChoices = app.buttons.matching(identifier: "add-to-playlist-all-\(confusablePlaylist.id)")
    let choice = allChoices.element
    XCTAssertTrue(
      choice.waitForExistence(timeout: 15),
      "the sheet must list every playlist\n\(app.debugDescription)")
    XCTAssertEqual(allChoices.count, 1, "All Playlists must have one identifiable row")
    XCTAssertTrue(confusableChoices.element.waitForExistence(timeout: 15))
    XCTAssertEqual(confusableChoices.count, 1, "a confusable name must have its own identifiable row")
    capture("add-to-playlist-sheet")
    choice.tap()
    XCTAssertFalse(choice.waitForExistence(timeout: 5), "choosing a playlist must close the sheet")
    let stored = try storedOrder(of: playlist.id, in: service, becomes: [set.id])
    steps.append(["step": "add from the Set page", "expected": [set.id], "stored": stored])
    XCTAssertEqual(stored, [set.id], "the service must store the membership")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-playlist"].tap()
    XCTAssertTrue(app.navigationBars["Add to Playlist"].waitForExistence(timeout: 15))
    let allCount = allChoices.count
    let recentCount = recentChoices.count
    steps.append([
      "step": "reopen with Recents and All Playlists",
      "playlistId": playlist.id, "confusablePlaylistId": confusablePlaylist.id,
      "allRows": allCount, "recentRows": recentCount, "confusableAllRows": confusableChoices.count,
    ])
    capture("add-to-playlist-added")
    XCTAssertEqual(allCount, 1, "All Playlists must have exactly one identifiable row")
    XCTAssertEqual(recentCount, 1, "Recents must have exactly one identifiable row")
    XCTAssertEqual(confusableChoices.count, 1, "the confusable playlist must keep one All Playlists row")
    guard allCount == 1, recentCount == 1 else {
      try record("add-to-playlist", steps)
      return
    }
    let recentChoice = recentChoices.element
    XCTAssertEqual(choice.value as? String, "Added", "All Playlists must mark the joined playlist")
    XCTAssertEqual(recentChoice.value as? String, "Added", "Recents must mark the joined playlist")

    recentChoice.tap()
    let afterRemove = try storedOrder(of: playlist.id, in: service, becomes: [])
    steps.append(["step": "remove through Recents", "expected": [], "stored": afterRemove])
    XCTAssertEqual(afterRemove, [], "removing through Recents must remove the membership")
    let confusableAfterRemove = try service.members(of: confusablePlaylist.id).map(\.id)
    steps.append(["step": "confusable playlist after removal", "expected": [], "stored": confusableAfterRemove])
    XCTAssertEqual(confusableAfterRemove, [], "removing through Recents must leave the other playlist empty")
    let removed = [choice, recentChoice].map {
      XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", ""), object: $0)
    }
    XCTAssertEqual(XCTWaiter.wait(for: removed, timeout: 15), .completed)
    XCTAssertEqual(allChoices.count, 1, "All Playlists must keep its identifiable row after removal")
    XCTAssertEqual(recentChoices.count, 1, "Recents must keep its identifiable row after removal")
    capture("add-to-playlist-removed-through-recents")

    choice.tap()
    XCTAssertFalse(choice.waitForExistence(timeout: 5), "adding through All Playlists must close the sheet")
    let afterReadd = try storedOrder(of: playlist.id, in: service, becomes: [set.id])
    steps.append(["step": "re-add through All Playlists", "expected": [set.id], "stored": afterReadd])
    XCTAssertEqual(afterReadd, [set.id], "re-adding through All Playlists must restore membership once")
    let confusableAfterReadd = try service.members(of: confusablePlaylist.id).map(\.id)
    steps.append(["step": "confusable playlist after re-adding", "expected": [], "stored": confusableAfterReadd])
    XCTAssertEqual(confusableAfterReadd, [], "re-adding through All Playlists must leave the other playlist empty")

    app.buttons["detail-actions"].tap()
    app.buttons["detail-playlist"].tap()
    XCTAssertTrue(app.navigationBars["Add to Playlist"].waitForExistence(timeout: 15))
    XCTAssertEqual(allChoices.count, 1, "All Playlists must keep one identifiable row after re-adding")
    XCTAssertEqual(recentChoices.count, 1, "Recents must keep one identifiable row after re-adding")
    XCTAssertEqual(confusableChoices.count, 1, "the other playlist must keep one identifiable row after re-adding")
    XCTAssertEqual(confusableChoices.element.value as? String, "", "the other playlist must remain unselected")
    XCTAssertEqual(choice.value as? String, "Added", "All Playlists must show restored membership")
    XCTAssertEqual(recentChoice.value as? String, "Added", "Recents must show restored membership")
    steps.append([
      "step": "both sections show restored membership",
      "playlistId": playlist.id, "confusablePlaylistId": confusablePlaylist.id,
      "allRows": allChoices.count, "recentRows": recentChoices.count,
      "confusableAllRows": confusableChoices.count,
      "allValue": choice.value as? String ?? "", "recentValue": recentChoice.value as? String ?? "",
    ])
    capture("add-to-playlist-readded-through-all")
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

  func testNoPlaylistsInvitesCreation() throws {
    let service = try LaneService()
    for playlist in try service.playlists() {
      try service.deletePlaylist(playlist.id)
    }

    let app = try launch()
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
}
