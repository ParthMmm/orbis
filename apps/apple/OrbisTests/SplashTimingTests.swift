import XCTest

@testable import Orbis

/// The splash covers the first load, so how long it stays is a policy rather than a constant.
/// Both ends are promises to a person waiting: the floor is that the orb is not a flash frame,
/// and the ceiling is that a logo never stands where an explanation should be.
final class SplashTimingTests: XCTestCase {
  private let timing = SplashTiming()

  /// And the ceiling ends the wait whatever the load is doing, because a service that is
  /// paired but unreachable answers by not answering.
  func testTheCeilingEndsTheWaitWhateverTheLoadIsDoing() {
    XCTAssertTrue(timing.shouldDismiss(after: timing.ceiling, firstLoadSettled: false))
    XCTAssertTrue(timing.shouldDismiss(after: .seconds(30), firstLoadSettled: false))
  }
}
