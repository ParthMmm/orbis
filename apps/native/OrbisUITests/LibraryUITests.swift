import XCTest

/// Drives the real first-launch path against a server the lane starts. The address and
/// token come from the environment so the test types them exactly as a person would.
final class LibraryUITests: XCTestCase {
    private func launch() throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ORBIS_UI_TEST_ADDRESS"], !address.isEmpty,
              let token = environment["ORBIS_UI_TEST_TOKEN"], !token.isEmpty
        else {
            throw XCTSkip("the lane must supply ORBIS_UI_TEST_ADDRESS and ORBIS_UI_TEST_TOKEN")
        }
        let app = XCUIApplication()
        app.launchArguments.append("-orbisResetSettings")
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

    func testConnectsBrowsesAndSearchesTheLibrary() throws {
        let app = try launch()

        let address = app.textFields["connection-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 30), "the connection screen must appear\n\(app.debugDescription)")
        capture("01-connection")

        address.tap()
        address.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_ADDRESS"] ?? "")

        let token = app.secureTextFields["connection-token"]
        XCTAssertTrue(token.waitForExistence(timeout: 10))
        token.tap()
        token.typeText(ProcessInfo.processInfo.environment["ORBIS_UI_TEST_TOKEN"] ?? "")

        app.buttons["connection-test"].tap()

        let row = app.staticTexts["Night session"]
        XCTAssertTrue(row.waitForExistence(timeout: 60), "a saved Set must appear after connecting\n\(app.debugDescription)")
        capture("02-library-loaded")

        app.tabBars.buttons["Search"].tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "the Search destination must offer a field")
        field.tap()
        field.typeText("night")
        field.typeText("\n")
        XCTAssertTrue(row.waitForExistence(timeout: 30), "search must find the Set")
        capture("03-search-results")

        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        field.typeText("zzzznothing")
        field.typeText("\n")
        let noResults = app.staticTexts["No matching sets"]
        XCTAssertTrue(noResults.waitForExistence(timeout: 30), "an unmatched search must say so\n\(app.debugDescription)")
        capture("04-search-no-results")
    }

    func testUnreachableAddressNamesTheRecoveryAction() throws {
        let app = try launch()

        let address = app.textFields["connection-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 30))
        address.tap()
        address.typeText("http://127.0.0.1:1")

        let token = app.secureTextFields["connection-token"]
        token.tap()
        token.typeText("not-a-real-token")

        app.buttons["connection-test"].tap()

        let error = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Cannot reach your library")
        ).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 60), "an unreachable address must explain itself\n\(app.debugDescription)")
        capture("05-connection-error")
    }
}
