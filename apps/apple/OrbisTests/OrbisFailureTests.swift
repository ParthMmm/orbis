import XCTest

@testable import Orbis

/// The library's failure state used to wear one heading for every failure, so a service older
/// than the app told a person their network was down and offered a retry that could never work.
/// These pin the two halves of that: the heading names the real cause, and a retry appears only
/// when retrying could change the answer.
final class OrbisFailureTests: XCTestCase {
    func testAVersionSkewDoesNotBlameTheNetwork() {
        let failure = OrbisError.malformed.failure
        XCTAssertFalse(
            failure.title.localizedCaseInsensitiveContains("cannot reach"),
            "an unreadable answer is not an unreachable service"
        )
        XCTAssertFalse(failure.isRetryable, "a version skew does not mend itself by trying again")
        XCTAssertTrue(failure.message.contains("updated together"))
    }

    func testAnUnreachableServiceOffersARetry() {
        let failure = OrbisError.unreachable.failure
        XCTAssertEqual(failure.title, "Cannot reach your library")
        XCTAssertTrue(failure.isRetryable)
    }

    func testAServerFaultCanBeRetriedAndAClientMistakeCannot() {
        XCTAssertTrue(OrbisError.server(status: 500, message: "Busy.").failure.isRetryable)
        XCTAssertFalse(OrbisError.server(status: 400, message: "No.").failure.isRetryable)
        XCTAssertFalse(OrbisError.notPaired.failure.isRetryable)
        XCTAssertFalse(OrbisError.refused.failure.isRetryable)
        XCTAssertFalse(OrbisError.badAddress.failure.isRetryable)
    }

    func testEveryFailureSaysSomethingAndCarriesASymbol() {
        let failures: [OrbisError] = [
            .unreachable, .notPaired, .refused, .duplicate, .cancelled,
            .server(status: 503, message: "Busy."), .malformed, .badAddress,
        ]
        for failure in failures {
            XCTAssertFalse(failure.failure.title.isEmpty, "\(failure) has no heading")
            XCTAssertFalse(failure.failure.message.isEmpty, "\(failure) has no message")
            XCTAssertFalse(failure.failure.symbol.isEmpty, "\(failure) has no symbol")
        }
    }
}
