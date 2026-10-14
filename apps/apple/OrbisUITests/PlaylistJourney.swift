import XCTest

/// What every Playlist journey shares. The journeys live in two classes so two simulators can
/// run them at once.
class PlaylistJourney: XCTestCase {
  func launch() throws -> XCUIApplication {
    let service = try LaneService()
    return launchOrbis(address: service.address, token: service.token)
  }

  /// Same symbol tap as `LibraryUITests.selectTab`.
  func selectTab(_ name: String, in app: XCUIApplication) {
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

  func openPlaylists(in app: XCUIApplication) {
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

  func tapAtCentre(of element: XCUIElement, in app: XCUIApplication) {
    let frame = element.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
      .tap()
  }

  /// A name no earlier journey or run has used, since every journey shares the lane's service.
  func unique(_ prefix: String) -> String {
    "\(prefix) \(UUID().uuidString.prefix(6))"
  }

  func youtubeURL() -> String {
    let letters = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    return "https://www.youtube.com/watch?v=" + String((0..<11).map { _ in letters.randomElement()! })
  }

  /// Waits until the service stores the expected order, and returns what it last read.
  func storedOrder(
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
  func record(_ name: String, _ steps: [[String: Any]]) throws {
    let data = try JSONSerialization.data(
      withJSONObject: ["journey": name, "steps": steps], options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func openPlaylist(named name: String, in app: XCUIApplication) {
    openPlaylists(in: app)
    let row = app.descendants(matching: .any)["playlist-row-\(name)"]
    XCTAssertTrue(
      row.waitForExistence(timeout: 30), "the seeded playlist must be listed\n\(app.debugDescription)")
    tapAtCentre(of: row, in: app)
  }
}
