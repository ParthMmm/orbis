import Foundation
import XCTest

@testable import Orbis

/// When the app tells the service where playback has reached. The bound matters more than the
/// timing: a position write every five seconds of playback is twelve a minute, and a position that
/// stands still is not worth a request at all.
final class PositionReportingTests: XCTestCase {
  func testAPlayingSetReportsAtMostTwelveTimesAMinute() {
    // Five seconds between reports is the whole of the bound: a minute of playback cannot produce
    // more than twelve of them.
    XCTAssertEqual(PositionReporting.interval, .seconds(5))

    var reports = PositionReporting()
    var sent = 0
    for elapsed in stride(from: 0, to: 60, by: 5) {
      if reports.position(elapsed: TimeInterval(elapsed), state: .playing) != nil {
        sent += 1
      }
    }
    XCTAssertEqual(sent, 12)
  }

  func testASecondOfPlaybackIsReportedOnce() {
    var reports = PositionReporting()

    XCTAssertEqual(reports.position(elapsed: 12.4, state: .playing), 12)
    XCTAssertNil(reports.position(elapsed: 12.9, state: .playing))
    XCTAssertEqual(reports.position(elapsed: 13.2, state: .playing), 13)
  }

  func testPausingAndResumingAreBothWorthReporting() {
    var reports = PositionReporting()

    // The pause is where the other device should resume, so it is news even at the same second.
    XCTAssertEqual(reports.position(elapsed: 30, state: .playing), 30)
    XCTAssertEqual(reports.position(elapsed: 30, state: .paused), 30)
    // Standing still is not.
    XCTAssertNil(reports.position(elapsed: 30, state: .paused))
    // Resuming is.
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
