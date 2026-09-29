import OrbisDesign
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

  func testAServerFaultCanBeRetriedAndAClientMistakeCannot() {
    XCTAssertTrue(OrbisError.server(status: 500, message: "Busy.").failure().isRetryable)
    XCTAssertFalse(OrbisError.server(status: 400, message: "No.").failure().isRetryable)
    XCTAssertFalse(OrbisError.notPaired.failure().isRetryable)
    XCTAssertFalse(OrbisError.refused.failure().isRetryable)
    XCTAssertFalse(OrbisError.badAddress.failure().isRetryable)
    XCTAssertFalse(OrbisError.notOrbis.failure().isRetryable)
    XCTAssertTrue(OrbisError.unreachable.failure().isRetryable)
  }
}
