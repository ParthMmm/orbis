import OrbisDesign
import XCTest

@testable import Orbis

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
    XCTAssertFalse(OrbisError.notSignedIn.failure().isRetryable)
    XCTAssertFalse(OrbisError.notOrbis.failure().isRetryable)
    XCTAssertTrue(OrbisError.unreachable.failure().isRetryable)
  }
}
