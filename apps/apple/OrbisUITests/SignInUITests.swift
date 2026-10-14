import XCTest

/// Signing in and Settings (ADR 0020), against the lane's service. The Group Passcode is one
/// value for the whole service, so every journey that reads or changes it lives in this class,
/// which runs its tests one after another on one simulator.
final class SignInUITests: XCTestCase {
  private static let codePattern =
    "^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$"

  private var steps: [[String: Any]] = []

  // MARK: - Journeys

  /// A fresh install joins with the passcode the Host set, keeps its key across a relaunch,
  /// shows a Sign-in Code for another device, has no Host sections, and signs out.
  func testANewPersonJoinsWithThePasscodeAndAddsADevice() throws {
    let host = try LaneService()
    let passcode = "lane-\(Self.suffix())"
    let username = "journey-\(Self.suffix())"
    try host.setPasscode(passcode)

    // The key must reach the keychain, because the relaunch below reads it back.
    let app = launchOrbis(address: host.address, keychain: true)

    let new = app.buttons["signin-new"]
    XCTAssertTrue(new.waitForExistence(timeout: 30), "a fresh install must offer I'm New")
    XCTAssertTrue(app.buttons["signin-have-code"].exists, "and I Have a Code")
    XCTAssertEqual(
      app.textFields.count + app.secureTextFields.count, 0,
      "the first screen asks for no address, key, or device name\n\(app.debugDescription)")
    capture("01-signed-out")
    step("a fresh install offers two choices and no fields")

    new.tap()
    let usernameField = app.textFields["signin-username"]
    XCTAssertTrue(usernameField.waitForExistence(timeout: 10))
    usernameField.tap()
    usernameField.typeText(username)
    let passcodeField = app.textFields["signin-passcode"]
    passcodeField.tap()
    passcodeField.typeText("not-the-passcode")
    app.buttons["signin-join"].tap()

    let error = app.staticTexts["signin-error"]
    XCTAssertTrue(
      error.waitForExistence(timeout: 30), "a wrong passcode must be refused\n\(app.debugDescription)")
    XCTAssertFalse(
      error.label.hasPrefix("The service"), "the service's own sentence is shown: \(error.label)")
    XCTAssertTrue(app.buttons["copy-failure"].exists, "a failure offers its details to copy")
    capture("02-wrong-passcode")
    step("a wrong passcode shows the service's sentence", ["message": error.label])

    replaceText(in: passcodeField, with: passcode, app: app)
    app.buttons["signin-join"].tap()
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "joining must land in the library\n\(app.debugDescription)")
    // A new Person has no Sets, so Home is the first screen they see with nothing on it. It once
    // showed only a strip of glow down the middle.
    XCTAssertTrue(
      app.descendants(matching: .any)["home-empty"].waitForExistence(timeout: 15),
      "a new Person's Home must say the collection is empty\n\(app.debugDescription)")
    capture("03-joined")
    XCTAssertTrue(
      try host.people().contains { $0.username == username },
      "the Host's People must list the new Person")
    step("the right passcode creates the Person and signs in", ["username": username])

    app.terminate()
    app.launchArguments = ["-orbisServiceAddress", host.address]
    app.launch()
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a relaunch must keep the key\n\(app.debugDescription)")
    step("a relaunch reads the key back from the keychain")

    openSettings(app)
    let account = app.buttons["settings-account"]
    XCTAssertTrue(account.waitForExistence(timeout: 15))
    XCTAssertTrue(account.label.contains(username), "the account card names the Person: \(account.label)")
    let another = app.buttons["settings-sign-in-another"]
    reveal(another, in: app)
    another.tap()
    let code = app.staticTexts["settings-sign-in-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "Settings must show a Sign-in Code")
    XCTAssertNotNil(
      code.label.range(of: Self.codePattern, options: .regularExpression),
      "the code is eight characters without look-alikes, shown in halves: \(code.label)")
    capture("04-settings-sign-in-code")
    assertNoHostSections(app)
    step("Settings shows the Person's name and a Sign-in Code, and no Host sections")

    let signOut = app.buttons["settings-sign-out"]
    reveal(signOut, in: app)
    signOut.tap()
    confirm("Sign Out", besides: "settings-sign-out", in: app)
    XCTAssertTrue(
      app.buttons["signin-new"].waitForExistence(timeout: 15),
      "signing out returns to the first screen\n\(app.debugDescription)")
    capture("05-signed-out-again")
    step("signing out forgets the key")

    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.buttons["signin-new"].waitForExistence(timeout: 30), "the key stays forgotten")
    app.terminate()
    record("join")
  }

  /// A fresh install types a code another device showed, loosely: lowercase, with a space.
  func testACodeFromAnotherDeviceSignsIn() throws {
    let friend = try friendService()
    let devicesBefore = Set(try friend.devices().map(\.id))
    let app = launchOrbis(address: friend.address)

    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30))
    haveCode.tap()
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("zzzz-zzzz")
    app.buttons["signin-redeem"].tap()
    let error = app.staticTexts["signin-error"]
    XCTAssertTrue(
      error.waitForExistence(timeout: 30), "an unknown code is refused\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["copy-failure"].exists)
    capture("01-unknown-code")
    step("an unknown code shows the service's sentence", ["message": error.label])

    let code = try friend.signInCode()
    let typed = "\(code.prefix(4)) \(code.suffix(4))".lowercased()
    replaceText(in: field, with: typed, app: app)
    app.buttons["signin-redeem"].tap()
    XCTAssertTrue(
      app.tabBars.buttons["Library"].waitForExistence(timeout: 30),
      "a code must sign in\n\(app.debugDescription)")
    capture("02-signed-in")
    step("a lowercase code with a space signs in", ["typed": typed])

    var added: LaneService.Device?
    XCTAssertTrue(
      try waitUntil(timeout: 15) {
        added = try friend.devices().first { !devicesBefore.contains($0.id) }
        return added?.lastUsedAt != nil
      }, "the new device holds its own key and has used it")
    step("the service lists the device under its own name", ["label": added?.label ?? ""])
    if let added {
      XCTAssertEqual(try friend.revokeDevice(added.id), 200)
    }
    app.terminate()
    record("redeem")
  }

  func testAnUnreachableServiceNamesTheRecoveryAction() throws {
    let app = launchOrbis(address: "http://127.0.0.1:1")

    let haveCode = app.buttons["signin-have-code"]
    XCTAssertTrue(haveCode.waitForExistence(timeout: 30))
    haveCode.tap()
    let field = app.textFields["signin-code"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("ABCDEFGH")
    app.buttons["signin-redeem"].tap()

    let error = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Cannot reach your library")
    ).firstMatch
    XCTAssertTrue(
      error.waitForExistence(timeout: 60),
      "an unreachable service must explain itself\n\(app.debugDescription)")
    XCTAssertTrue(app.buttons["copy-failure"].exists, "a failure must offer its details to copy")
    capture("unreachable-service")
  }

  /// The Host's Settings shows the Group Passcode and People, changes and clears the passcode,
  /// shows a Person's Sign-in Code, and removes a Person.
  func testTheHostManagesThePasscodeAndPeople() throws {
    let host = try LaneService()
    try host.setPasscode("lane-before")
    let leaving = try host.addPerson("journey-leaving-\(Self.suffix())")
    let app = launchOrbis(address: host.address, token: host.token)

    openSettings(app)
    let passcodeRow = app.buttons["settings-passcode-row"]
    reveal(passcodeRow, in: app)
    XCTAssertTrue(
      waitUntil(timeout: 15) { passcodeRow.label.contains("lane-before") },
      "the Host sees the current passcode\n\(app.debugDescription)")
    capture("01-host-settings")
    step("the Host's Settings shows the Group Passcode")

    passcodeRow.tap()
    let passcode = app.textFields["settings-passcode"]
    XCTAssertTrue(passcode.waitForExistence(timeout: 10), "the passcode page offers a field")
    replaceText(in: passcode, with: "lane-after", app: app)
    app.buttons["settings-passcode-save"].tap()
    XCTAssertTrue(
      try waitUntil(timeout: 15) { try host.passcode() == "lane-after" },
      "the new passcode reaches the service")
    step("changing the passcode reaches the service")

    let friendRow = app.buttons["person-lane-settings"]
    reveal(friendRow, in: app)
    XCTAssertTrue(friendRow.exists, "People lists the Group\n\(app.debugDescription)")
    friendRow.tap()
    let show = app.buttons["person-show-code"]
    XCTAssertTrue(show.waitForExistence(timeout: 10))
    show.tap()
    let code = app.staticTexts["person-sign-in-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "the Host can show a friend's code")
    XCTAssertNotNil(code.label.range(of: Self.codePattern, options: .regularExpression))
    capture("02-person-sign-in-code")
    step("the Host shows a Sign-in Code for a friend")
    app.navigationBars.buttons.element(boundBy: 0).tap()

    let leavingRow = app.buttons["person-\(leaving.username)"]
    reveal(leavingRow, in: app)
    leavingRow.tap()
    let remove = app.buttons["person-remove"]
    XCTAssertTrue(remove.waitForExistence(timeout: 10))
    remove.tap()
    confirm("Remove", besides: "person-remove", in: app)
    XCTAssertTrue(
      try waitUntil(timeout: 15) { try !host.people().contains { $0.id == leaving.id } },
      "removing a Person reaches the service")
    XCTAssertTrue(
      waitUntil(timeout: 10) { !leavingRow.exists }, "and leaves the People list")
    step("the Host removes a Person after confirming")

    let joining = app.switches["settings-joining"]
    reveal(joining, in: app)
    joining.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertTrue(
      try waitUntil(timeout: 15) { try host.passcode() == nil }, "closing joining clears it")
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Joining is closed'"))
        .firstMatch.waitForExistence(timeout: 10))
    capture("03-joining-closed")
    step("closing joining clears the passcode")
    app.terminate()
    record("host")
  }

  /// A friend's Auto Download shows what the service stores, a change follows them across a
  /// relaunch, and their Settings has no Host sections. The journey starts from whatever the
  /// lane seeded and leaves it as it found it.
  func testAFriendsSettingsKeepAutoDownloadAndHaveNoHostSections() throws {
    let friend = try friendService()
    let stored = try friend.autoDownload()
    let switchValue = { (enabled: Bool) in enabled ? "1" : "0" }
    let app = launchOrbis(address: friend.address, token: friend.token)
    openSettings(app)
    let toggle = app.switches["auto-download"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    XCTAssertEqual(toggle.value as? String, switchValue(stored), "the toggle shows the stored value")
    capture("auto-download-as-stored")
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    XCTAssertTrue(waitUntil(timeout: 10) { toggle.value as? String == switchValue(!stored) })
    let afterChange = try friend.autoDownload(becomes: !stored)
    XCTAssertEqual(afterChange, !stored, "the change reaches the service")
    capture("auto-download-changed")
    assertNoHostSections(app)
    capture("friend-settings-end")
    app.terminate()
    app.launch()
    openSettings(app)
    XCTAssertTrue(toggle.waitForExistence(timeout: 10))
    let afterRelaunch = toggle.value as? String == switchValue(!stored)
    XCTAssertTrue(afterRelaunch, "the change survives a relaunch")
    capture("auto-download-changed-reopened")
    toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    let restored = try friend.autoDownload(becomes: stored)
    XCTAssertEqual(restored, stored, "the journey restores the stored value")
    capture("auto-download-restored")
    steps = [
      [
        "afterChange": afterChange, "afterRelaunch": afterRelaunch, "name": "auto download",
        "restored": restored, "stored": stored,
      ]
    ]
    record("auto-download-settings")
  }

  // MARK: - Helpers

  private func friendService() throws -> LaneService {
    guard let token = ProcessInfo.processInfo.environment["ORBIS_UI_TEST_SETTINGS_TOKEN"],
      !token.isEmpty
    else { throw XCTSkip("The lane must supply the settings Person") }
    return try LaneService(tokenOverride: token)
  }

  private func openSettings(_ app: XCUIApplication) {
    let gear = app.buttons["settings-open"].firstMatch
    XCTAssertTrue(gear.waitForExistence(timeout: 30), "Home must offer Settings")
    gear.tap()
  }

  /// Scrolls to the version at the foot of Settings, where the Host's sections would sit just
  /// above, and checks they are not there.
  private func assertNoHostSections(_ app: XCUIApplication) {
    let version = app.staticTexts["settings-version"]
    reveal(version, in: app)
    XCTAssertTrue(version.exists, "Settings ends with the app version\n\(app.debugDescription)")
    XCTAssertTrue(version.label.hasPrefix("Orbis "), version.label)
    XCTAssertFalse(
      app.switches["settings-joining"].exists, "a friend must not see joining")
    XCTAssertEqual(
      app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'person-'")).count, 0,
      "a friend must not see People")
  }

  /// Scrolls the Settings sheet until `element` is on screen. A grouped form only builds the
  /// rows it shows.
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
    var swipes = 0
    while !(element.exists && element.isHittable), swipes < 6 {
      app.swipeUp()
      swipes += 1
    }
  }

  /// Taps the confirming button of a dialog, which carries the same words as a row behind it.
  private func confirm(_ label: String, besides identifier: String, in app: XCUIApplication) {
    let button = app.buttons.matching(
      NSPredicate(format: "label == %@ AND identifier != %@", label, identifier)
    ).firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 10), "the dialog must ask first")
    button.tap()
  }

  /// Deletes what a field holds and types `text`. More deletes than the field can hold, with the
  /// cursor put at the end.
  private func replaceText(in field: XCUIElement, with text: String, app: XCUIApplication) {
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + text)
  }

  private func waitUntil(timeout: TimeInterval, _ condition: () throws -> Bool) rethrows -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if try condition() { return true }
      usleep(250_000)
    } while Date() < deadline
    return try condition()
  }

  private static func suffix() -> String {
    String(UUID().uuidString.prefix(6)).lowercased()
  }

  private func step(_ name: String, _ detail: [String: Any] = [:]) {
    steps.append(detail.merging(["name": name]) { current, _ in current })
  }

  private func record(_ name: String) {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: ["steps": steps], options: [.prettyPrinted, .sortedKeys])
    else { return }
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "\(name).json"
    attachment.lifetime = .keepAlways
    add(attachment)
    steps = []
  }
}
