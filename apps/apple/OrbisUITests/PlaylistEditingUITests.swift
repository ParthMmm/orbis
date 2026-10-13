import XCTest

/// Creating, reordering, and removing Playlist members.
final class PlaylistEditingUITests: PlaylistJourney {
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
    XCTAssertTrue(rows[0].waitForNonExistence(timeout: 5), "the removed row must leave the playlist")
    XCTAssertLessThan(
      rows[2].frame.minY, rows[1].frame.minY, "the screen must show the order the service stored")
    capture("playlist-order-removed")

    let library = try service.library().map(\.id)
    steps.append(["step": "removed Set stays in the Library", "stored": library.contains(first.id)])
    XCTAssertTrue(library.contains(first.id), "leaving a playlist must not remove the Set")
    try record("playlist-order", steps)
  }
}
