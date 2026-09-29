import XCTest

final class ConnectionUITests: XCTestCase {
  private func openSettings(_ app: XCUIApplication) {
    let library = app.tabBars.buttons["Library"]
    XCTAssertTrue(library.waitForExistence(timeout: 15))
    let frame = library.frame
    app.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: frame.midX, dy: frame.minY + 18)).tap()
    let actions = app.buttons["library-actions"]
    XCTAssertTrue(actions.waitForExistence(timeout: 10))
    actions.tap()
    app.buttons["library-connection-settings"].tap()
  }

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testAutoDownloadFollowsThePersonAfterRelaunch() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let token = environment["ORBIS_UI_TEST_SETTINGS_TOKEN"], !token.isEmpty,
      let address = environment["ORBIS_UI_TEST_ADDRESS"]
    else { throw XCTSkip("The lane must supply the settings Person") }
    let service = try LaneService(tokenOverride: token)
    let app = XCUIApplication()
    app.launchArguments = ["-orbisResetSettings", "-orbisPairedWith", address, token]
    app.launchEnvironment["ORBIS_TEST_SETTINGS"] = "memory"
    app.launch()
    openSettings(app)
    let toggle = app.switches["auto-download"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    XCTAssertEqual(toggle.value as? String, "1")
    capture("auto-download-default-on")
    toggle.tap()
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '0'"), object: toggle)], timeout: 10),
      .completed)
    let off = try service.autoDownload(becomes: false)
    XCTAssertFalse(off)
    capture("auto-download-off")
    app.terminate()
    app.launch()
    openSettings(app)
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    let reopenedOff = toggle.value as? String == "0"
    XCTAssertTrue(reopenedOff)
    capture("auto-download-off-reopened")
    toggle.tap()
    let on = try service.autoDownload(becomes: true)
    XCTAssertTrue(on)
    capture("auto-download-restored-on")
    let data = try JSONSerialization.data(
      withJSONObject: ["afterOff": off, "afterOn": on, "offAfterRelaunch": reopenedOff],
      options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "auto-download-settings.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
