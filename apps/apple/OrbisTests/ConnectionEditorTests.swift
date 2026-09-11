import XCTest

@testable import Orbis

/// An address that stops working used to leave Forget this device as the only way back to it,
/// which throws away a working pairing to correct a typo.
@MainActor
final class ConnectionEditorTests: XCTestCase {
    func testEditingTheConnectionKeepsTheLibraryAndAsksForTheTokenAgain() {
        let model = AppModel()
        model.library = .loaded([])
        model.connectionAddress = "https://library.example"
        model.connectionToken = "a token already used"

        model.editConnection()

        XCTAssertTrue(model.isEditingConnection)
        XCTAssertFalse(
            model.connectionAddress.isEmpty, "the screen must open with an address to correct")
        XCTAssertTrue(model.connectionToken.isEmpty, "the token is not left in the field")
        guard case .loaded = model.library else {
            return XCTFail("the library behind the screen must survive")
        }
    }

    func testLeavingTheEditorKeepsWhatWasWorking() {
        let model = AppModel()
        model.library = .loaded([])
        model.editConnection()
        model.closeConnectionEditor()

        XCTAssertFalse(model.isEditingConnection)
        guard case .loaded = model.library else {
            return XCTFail("closing the editor must not touch the library")
        }
    }

    func testForgettingClosesTheEditorAndTheLibrary() {
        let model = AppModel()
        model.library = .loaded([])
        model.editConnection()
        model.forget()

        XCTAssertFalse(model.isEditingConnection)
        XCTAssertEqual(model.library, .idle)
    }
}
