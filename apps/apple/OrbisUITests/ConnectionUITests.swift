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

  func testDeviceLinkSignsInAndKeepsItsKeyAfterRelaunch() throws {
    let service = try LaneService()
    let app = XCUIApplication()
    app.launchArguments = ["-orbisResetSettings", "-orbisServiceAddress", service.address]
    app.launch()
    let start = app.buttons["device-link-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 10))
    XCTAssertFalse(app.textFields["connection-address"].exists)
    start.tap()
    let code = app.staticTexts["device-link-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    XCTAssertTrue(app.images["device-link-qr"].exists)
    capture("device-link-awaiting-approval")
    try service.approveDeviceLink(code.label)
    XCTAssertTrue(app.tabBars.buttons["Library"].waitForExistence(timeout: 20))
    capture("device-link-signed-in")
    app.terminate()
    app.launchArguments = []
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Library"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["device-link-start"].exists)
    capture("device-link-keychain-reopened")
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
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
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
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
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
