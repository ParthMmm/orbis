import XCTest

@testable import Orbis

/// The splash covers the first load, so how long it stays is a policy rather than a constant.
/// Both ends are promises to a person waiting: the floor is that the orb is not a flash frame,
/// and the ceiling is that a logo never stands where an explanation should be.
final class SplashTimingTests: XCTestCase {
  private let timing = SplashTiming()

  /// A load that answered at once still waits for the floor.
  func testASettledLoadDismissesAtTheFloor() {
    XCTAssertFalse(timing.shouldDismiss(after: .milliseconds(100), firstLoadSettled: true))
    XCTAssertFalse(
      timing.shouldDismiss(after: timing.floor - .milliseconds(1), firstLoadSettled: true)
    )
    XCTAssertTrue(timing.shouldDismiss(after: timing.floor, firstLoadSettled: true))
  }

  /// A load that is still running holds the splash past the floor.
  func testAnUnsettledLoadHoldsPastTheFloor() {
    XCTAssertFalse(timing.shouldDismiss(after: timing.floor, firstLoadSettled: false))
    XCTAssertFalse(timing.shouldDismiss(after: .seconds(2), firstLoadSettled: false))
  }

  /// And the ceiling ends the wait whatever the load is doing, because a service that is
  /// paired but unreachable answers by not answering.
  func testTheCeilingEndsTheWaitWhateverTheLoadIsDoing() {
    XCTAssertTrue(timing.shouldDismiss(after: timing.ceiling, firstLoadSettled: false))
    XCTAssertTrue(timing.shouldDismiss(after: .seconds(30), firstLoadSettled: false))
  }

  /// The ceiling is the longer of the two, or the floor would be the only thing that mattered.
  func testTheCeilingOutlastsTheFloor() {
    XCTAssertGreaterThan(timing.ceiling, timing.floor)
  }

  /// An exit with no duration is the cut the fade exists to avoid.
  func testTheExitTakesTime() {
    XCTAssertGreaterThan(timing.fade, .zero)
  }
}
