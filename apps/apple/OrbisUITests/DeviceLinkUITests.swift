import XCTest

/// A fresh install signs in with a Device Link (ADR 0016): the app shows a code and a QR code for
/// the approval page, the lane's Person approves it through the real service, and the app signs
/// in with a key of its own. A relaunch keeps that pairing without signing in again.
final class DeviceLinkUITests: XCTestCase {
  private var steps: [[String: Any]] = []

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func step(_ name: String, _ detail: [String: Any] = [:]) {
    steps.append(detail.merging(["name": name]) { current, _ in current })
  }

  private func waitUntil(timeout: TimeInterval, _ condition: () throws -> Bool) rethrows -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if try condition() { return true }
      usleep(250_000)
    } while Date() < deadline
    return try condition()
  }

  func testSignsInWithADeviceLinkAndKeepsThePairing() throws {
    let service = try LaneService()
    let label = "Journey iPhone \(UUID().uuidString.prefix(6))"

    // No `ORBIS_TEST_SETTINGS=memory` here: the pairing must reach the keychain, because the
    // relaunch below reads it back. The reset at each end keeps the lane simulator clean.
    let app = XCUIApplication()
    app.launchArguments = ["-orbisResetSettings", "-orbisServiceAddress", service.address]
    app.launch()

    let labelField = app.textFields["device-link-label"]
    XCTAssertTrue(
      labelField.waitForExistence(timeout: 30),
      "a fresh install must offer a Device Link\n\(app.debugDescription)")
    XCTAssertFalse(
      app.textFields["connection-address"].exists, "a fresh install must not ask for an address")
    XCTAssertTrue(
      app.secureTextFields["connection-token"].exists, "pasting a key must stay available")
    capture("01-sign-in")
    step("a fresh install offers a code and a key, and asks for no address")

    // The default name comes from the simulator, whose name differs between clones. Put the
    // cursor at the end and delete more than the field can hold, the limit being 100.
    labelField.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    labelField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 110) + label)
    XCTAssertEqual(labelField.value as? String, label)
    app.buttons["device-link-start"].tap()

    let codeText = app.staticTexts["device-link-code"]
    XCTAssertTrue(
      codeText.waitForExistence(timeout: 30), "the app must show a code\n\(app.debugDescription)")
    let code = codeText.label
    XCTAssertNotNil(
      code.range(
        of: "^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$",
        options: .regularExpression),
      "the code must be eight characters without look-alikes, got \(code)")
    let qr = app.images["device-link-qr"]
    XCTAssertTrue(qr.exists, "the app must show a QR code\n\(app.debugDescription)")
    let approvalLink = qr.value as? String
    XCTAssertEqual(approvalLink, "https://orbis.p11a.xyz/link#\(code)")
    XCTAssertTrue(app.descendants(matching: .any)["device-link-waiting"].exists)
    capture("02-code-and-qr")
    step("the app shows a code and a QR code for the approval page", ["qr": approvalLink ?? ""])

    let pending = try service.lookupDeviceLink(code)
    XCTAssertEqual(pending.label, label, "the approving device must see this device's name")
    XCTAssertEqual(try service.approveDeviceLink(code), 200)
    step("the lane's Person sees the device name and approves the code", ["label": pending.label])

    let libraryTab = app.tabBars.buttons["Library"]
    XCTAssertTrue(
      libraryTab.waitForExistence(timeout: 30),
      "the app must sign in once the code is approved\n\(app.debugDescription)")
    XCTAssertFalse(labelField.exists)
    capture("03-signed-in")
    step("the app signs in without a key being typed")

    // The app's own key is a new daily key under the name it gave, and the app has used it.
    var linked: LaneService.Device?
    XCTAssertTrue(
      try waitUntil(timeout: 15) {
        linked = try service.devices().first { $0.label == label }
        return linked?.lastUsedAt != nil
      }, "the approved device must hold its own key and use it")
    step("the service lists a key under the device name, used by the app")

    XCTAssertEqual(try service.approveDeviceLink(code), 404, "a code approves one device once")
    step("a second approval of the same code fails")

    app.terminate()
    app.launchArguments = ["-orbisServiceAddress", service.address]
    app.launch()
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a relaunch must keep the pairing the Device Link made\n\(app.debugDescription)")
    XCTAssertFalse(app.textFields["device-link-label"].exists)
    capture("04-relaunched-still-signed-in")
    step("a relaunch reads the key back from the keychain and stays signed in")

    if let linked {
      XCTAssertEqual(try service.revokeDevice(linked.id), 200)
    }
    app.terminate()
    app.launchArguments = ["-orbisResetSettings", "-orbisServiceAddress", service.address]
    app.launch()
    XCTAssertTrue(app.textFields["device-link-label"].waitForExistence(timeout: 30))
    app.terminate()
    step("the journey revokes its key and clears the pairing")

    let data = try JSONSerialization.data(
      withJSONObject: ["steps": steps], options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "device-link.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
