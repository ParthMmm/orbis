import XCTest

/// Downloads, playback, the Tracklist, the mini player and Now Playing.
final class PlaybackUITests: LibraryJourney {
  func testCancelsAndRetriesADownload() throws {
    let service = try LaneService()
    let seeded = try service.saveSlowDownloadSet(
      title: "Download twice", url: "https://www.youtube.com/watch?v=slowaudio01")
    var observations: [LaneService.DownloadObservation] = []
    defer {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      encoder.dateEncodingStrategy = .iso8601
      do {
        let data = try encoder.encode(observations)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "download-cancel-retry"
        attachment.lifetime = .keepAlways
        add(attachment)
      } catch {
        XCTFail("Could not record download states: \(error)")
      }
    }
    func observe(_ phase: String, until matches: (LaneService.AudioState) -> Bool) throws {
      let deadline = Date().addingTimeInterval(30)
      repeat {
        let state = try service.audioState(seeded.id)
        observations.append(
          .init(phase: phase, observedAt: Date(), setId: seeded.id, audio: state))
        if matches(state) { return }
        usleep(200_000)
      } while Date() < deadline
      XCTFail("Download did not reach \(phase)")
      throw URLError(.timedOut)
    }
    let app = try launch(paired: true)
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    tapAtCentre(of: row, in: app)
    let download = app.descendants(matching: .any)["detail-download"].firstMatch
    XCTAssertTrue(download.waitForExistence(timeout: 15))
    try observe("initial") { $0.state == "none" }
    tapAtCentre(of: download, in: app)
    try observe("first-download") { $0.hasProgress }
    let progress = app.descendants(matching: .any).matching(
      NSPredicate(format: "label MATCHES %@", "Downloading [1-9][0-9]?%")
    ).firstMatch
    XCTAssertTrue(progress.waitForExistence(timeout: 15), "The page must show partial progress")
    XCTAssertFalse(app.buttons["detail-play-toggle"].exists)
    capture("download-first-progress")
    app.buttons["detail-cancel-download"].tap()
    try observe("canceled") { $0.state == "none" && $0.bytesReceived == 0 }
    XCTAssertTrue(app.buttons["Download"].waitForExistence(timeout: 15))
    capture("download-canceled")
    tapAtCentre(of: download, in: app)
    try observe("second-download") { $0.hasProgress }
    XCTAssertTrue(progress.waitForExistence(timeout: 15), "The retry must show partial progress")
    XCTAssertFalse(app.buttons["detail-play-toggle"].exists)
    capture("download-retry-progress")
    try service.finishSlowDownload(seeded.id)
    try observe("ready") { $0.state == "ready" }
    XCTAssertTrue(app.buttons["detail-play-toggle"].waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["detail-cancel-download"].exists)
    capture("download-retry-ready")
  }

  func testPlaysASetWithRetainedAudio() throws {
    let seeded = try LaneService().saveReadySet(
      title: "Ready to play", url: "https://www.youtube.com/watch?v=readyaudio1")
    let app = try launch(paired: true)
    openLibrary(in: app)

    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    XCTAssertFalse(app.buttons["Download"].exists)
    play.tap()
    let seek = app.sliders["detail-seek"]
    let advanced = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value != %@", "0:00"), object: seek)
    XCTAssertEqual(XCTWaiter.wait(for: [advanced], timeout: 6), .completed)
    XCTAssertEqual(app.buttons["detail-play-toggle"].label, "Pause")
    capture("16-ready-audio-playing")
  }

  func testPlaysAndSeeksFromTracklistCues() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Tracklist journey", url: "https://www.youtube.com/watch?v=tracklist01")
    try service.seedTracklist(seeded.id)
    let app = try launch(paired: true)
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let tracklist = app.descendants(matching: .any)["tracklist"]
    XCTAssertTrue(tracklist.waitForExistence(timeout: 30))
    let first = app.buttons["cue-0"]
    let second = app.buttons["cue-1"]
    XCTAssertTrue(second.exists)
    XCTAssertEqual(second.label, "Second Cue, Second Artist, starts at 0:12")
    XCTAssertFalse(app.buttons["cue-2"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["cue-2"].exists)
    for _ in 0..<3 {
      if second.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(second.isHittable)
    capture("tracklist-before-play")

    second.tap()
    let seek = app.sliders["detail-seek"]
    XCTAssertTrue(seek.waitForExistence(timeout: 15))
    let startedAtCue = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value BEGINSWITH %@", "0:1"), object: seek)
    XCTAssertEqual(XCTWaiter.wait(for: [startedAtCue], timeout: 8), .completed)
    XCTAssertTrue(second.isSelected)
    capture("tracklist-second-cue-playing")

    for _ in 0..<3 {
      if seek.isHittable { break }
      app.swipeDown()
    }
    XCTAssertTrue(seek.isHittable)
    capture("tracklist-elapsed-after-cue")

    let canSeek = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: seek)
    XCTAssertEqual(XCTWaiter.wait(for: [canSeek], timeout: 8), .completed)
    first.tap()
    let returnedToFirst = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value BEGINSWITH %@", "0:0"), object: seek)
    XCTAssertEqual(XCTWaiter.wait(for: [returnedToFirst], timeout: 5), .completed)
    XCTAssertTrue(first.isSelected)
    capture("tracklist-first-cue-playing")

    let pause = app.buttons["detail-play-toggle"]
    pause.tap()
    XCTAssertEqual(pause.label, "Play")

    app.navigationBars.buttons.firstMatch.tap()
    let openNowPlaying = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
    ).firstMatch
    XCTAssertTrue(openNowPlaying.waitForExistence(timeout: 10))
    openNowPlaying.tap()
    XCTAssertEqual(app.staticTexts["now-playing-cue"].label, "First Cue · First Artist")
    capture("tracklist-now-playing")
  }

  func testMiniPlayerNowPlayingAndStoredPosition() throws {
    let service = try LaneService()
    let seeded = try service.saveReadySet(
      title: "Now Playing journey", url: "https://www.youtube.com/watch?v=nowplaying1")
    let app = try launch(paired: true)
    openLibrary(in: app)
    let row = app.descendants(matching: .any)["set-row-\(seeded.id)"]
    XCTAssertTrue(row.waitForExistence(timeout: 60))
    tapAtCentre(of: row, in: app)

    let play = app.buttons["detail-play-toggle"]
    XCTAssertTrue(play.waitForExistence(timeout: 30))
    play.tap()
    XCTAssertFalse(app.buttons.matching(identifier: "mini-player").firstMatch.exists)
    capture("17-playing-on-set-page")

    app.navigationBars.buttons.firstMatch.tap()
    let miniToggle = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "mini-player", "Pause")
    ).firstMatch
    XCTAssertTrue(miniToggle.waitForExistence(timeout: 10))
    XCTAssertEqual(miniToggle.label, "Pause")
    capture("18-mini-player")

    let openNowPlaying = app.buttons.matching(
      NSPredicate(
        format: "identifier == %@ AND label == %@", "mini-player", "Now playing, \(seeded.title)")
    ).firstMatch
    openNowPlaying.tap()
    let title = app.staticTexts["now-playing-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    XCTAssertEqual(title.label, seeded.title)
    let seek = app.sliders["now-playing-seek"]
    let advanced = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value != %@", "0:00"), object: seek)
    XCTAssertEqual(XCTWaiter.wait(for: [advanced], timeout: 4), .completed)
    sleep(2)
    let beforePause = try service.set(id: seeded.id)?.playbackPositionSeconds ?? 0
    let pause = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "now-playing-play-toggle", "Pause")
    ).firstMatch
    pause.tap()
    let resume = app.buttons.matching(
      NSPredicate(format: "identifier == %@ AND label == %@", "now-playing-play-toggle", "Play")
    ).firstMatch
    XCTAssertTrue(resume.waitForExistence(timeout: 4))
    capture("19-now-playing-paused")

    let stored = try service.position(of: seeded.id, becomesAtLeast: beforePause + 1)
    XCTAssertGreaterThan(stored, beforePause)
    XCTAssertLessThan(stored, 30)
    let storedTitle = try service.set(id: seeded.id)?.title
    XCTAssertEqual(storedTitle, seeded.title)
    try record(
      "playback-position",
      [
        "setId": seeded.id,
        "expected": [
          "title": seeded.title, "minimumPositionSeconds": beforePause + 1,
          "maximumPositionSeconds": 29,
        ],
        "stored": [
          "title": storedTitle ?? "", "positionBeforePauseSeconds": beforePause,
          "positionSeconds": stored,
        ],
      ])
  }
}
