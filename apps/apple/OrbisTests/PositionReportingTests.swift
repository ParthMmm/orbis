import Foundation
import XCTest

@testable import Orbis

final class PositionReportingTests: XCTestCase {
  func testASecondOfPlaybackIsReportedOnce() {
    var reports = PositionReporting()

    XCTAssertEqual(reports.position(elapsed: 12.4, state: .playing), 12)
    XCTAssertNil(reports.position(elapsed: 12.9, state: .playing))
    XCTAssertEqual(reports.position(elapsed: 13.2, state: .playing), 13)
  }

  func testPausingAndResumingAreBothWorthReporting() {
    var reports = PositionReporting()

    XCTAssertEqual(reports.position(elapsed: 30, state: .playing), 30)
    XCTAssertEqual(reports.position(elapsed: 30, state: .paused), 30)
    XCTAssertNil(reports.position(elapsed: 30, state: .paused))
    XCTAssertEqual(reports.position(elapsed: 30, state: .playing), 30)
  }

  func testAPositionThatStandsStillIsNotReportedAgain() {
    var reports = PositionReporting()

    XCTAssertEqual(reports.position(elapsed: 45.9, state: .paused), 45)
    XCTAssertNil(reports.position(elapsed: 45.2, state: .paused))
  }

  func testASettledReportIsTheOneTheLibraryIsUpdatedWith() {
    XCTAssertTrue(PositionReporting.settles(.paused))
    XCTAssertTrue(PositionReporting.settles(.idle))
    XCTAssertFalse(PositionReporting.settles(.playing))
  }
}
