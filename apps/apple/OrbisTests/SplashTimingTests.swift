import XCTest

@testable import Orbis

final class SplashTimingTests: XCTestCase {
  private let timing = SplashTiming()

  func testTheCeilingEndsTheWaitWhateverTheLoadIsDoing() {
    XCTAssertTrue(timing.shouldDismiss(after: timing.ceiling, firstLoadSettled: false))
    XCTAssertTrue(timing.shouldDismiss(after: .seconds(30), firstLoadSettled: false))
  }
}
