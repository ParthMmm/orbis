import XCTest

@testable import Orbis

/// The library's failure state used to wear one heading for every failure, so a service older
/// than the app told a person their network was down and offered a retry that could never work.
/// These pin the two halves of that: the heading names the real cause, and a retry appears only
/// when retrying could change the answer.
final class OrbisFailureTests: XCTestCase {
    func testAVersionSkewDoesNotBlameTheNetwork() {
        let failure = OrbisError.malformed.failure(at: URL(string: "https://library.example"))
        XCTAssertFalse(
            failure.title.localizedCaseInsensitiveContains("cannot reach"),
            "an unreadable answer is not an unreachable service"
        )
        XCTAssertFalse(failure.isRetryable, "a version skew does not mend itself by trying again")
        XCTAssertEqual(
            failure.address, "https://library.example",
            "the failure must remember the address it asked")
    }

    func testAnUnreachableServiceOffersARetry() {
        let failure = OrbisError.unreachable.failure()
        XCTAssertEqual(failure.title, "Cannot reach your library")
        XCTAssertTrue(failure.isRetryable)
    }

    func testAServerFaultCanBeRetriedAndAClientMistakeCannot() {
        XCTAssertTrue(OrbisError.server(status: 500, message: "Busy.").failure().isRetryable)
        XCTAssertFalse(OrbisError.server(status: 400, message: "No.").failure().isRetryable)
        XCTAssertFalse(OrbisError.notPaired.failure().isRetryable)
        XCTAssertFalse(OrbisError.refused.failure().isRetryable)
        XCTAssertFalse(OrbisError.badAddress.failure().isRetryable)
    }

    func testEveryFailureSaysSomethingAndCarriesASymbol() {
        let failures: [OrbisError] = [
            .unreachable, .notPaired, .refused, .duplicate, .cancelled,
            .server(status: 503, message: "Busy."), .malformed, .badAddress,
        ]
        for failure in failures {
            XCTAssertFalse(failure.failure().title.isEmpty, "\(failure) has no heading")
            XCTAssertFalse(failure.failure().message.isEmpty, "\(failure) has no message")
            XCTAssertFalse(failure.failure().symbol.isEmpty, "\(failure) has no symbol")
        }
    }

    /// The copy button is only worth having if the pasted text answers the questions a reader
    /// would otherwise have to ask for.
    func testTheCopiedReportCarriesWhatAReaderNeeds() {
        let failure = OrbisError.malformed.failure(at: URL(string: "https://library.example:8444"))
        let text = FailureReport(failure: failure, context: "loading the library").text
        XCTAssertTrue(text.hasPrefix("Orbis "), "the build and platform lead the report")
        XCTAssertTrue(text.contains("What: That address is not your library"))
        XCTAssertTrue(text.contains("Where: https://library.example:8444"))
        XCTAssertTrue(text.contains("Doing: loading the library"))
        XCTAssertTrue(text.contains("Detail: "))
        XCTAssertTrue(text.contains("When: "))
    }

    func testAReportWithoutAnAddressLeavesThatLineOut() {
        let text = FailureReport(
            failure: OrbisError.unreachable.failure(), context: "loading the library"
        ).text
        XCTAssertFalse(text.contains("Where:"), "there is no address to name")
        XCTAssertTrue(text.contains("Cannot reach your library"))
    }
}
