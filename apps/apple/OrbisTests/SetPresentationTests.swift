import OrbisDesign
import XCTest

@testable import Orbis

@MainActor
final class SetPresentationTests: XCTestCase {
  private func makeSet(
    id: String = "one",
    url: String = "https://www.youtube.com/watch?v=abcdefghijk",
    title: String = "Night session",
    tags: String = #"["techno","breaks"]"#,
    createdAt: String = "2026-09-11T02:33:14.729Z",
    playbackPositionSeconds: Int = 0,
    durationSeconds: Int? = nil,
    creator: String? = nil,
    releasedAt: String? = nil,
    artworkUrl: String? = nil,
    artworkLargeUrl: String? = nil,
    downloadState: String = "none",
    lastListenedAt: String? = nil
  ) throws -> SavedSet {
    let json = """
      {"id":"\(id)","url":"\(url)","title":"\(title)","source":"youtube","tags":\(tags),
      "createdAt":"\(createdAt)","releasedAt":\(quoted(releasedAt)),"creator":\(quoted(creator)),
      "artworkUrl":\(quoted(artworkUrl)),
      "artworkLargeUrl":\(quoted(artworkLargeUrl)),"durationSeconds":\(durationSeconds.map(String.init) ?? "null"),
      "metadataState":"pending","titleEditedByUser":false,"downloadState":"\(downloadState)",
      "playlistIds":[],"retainedAudioBytes":null,"retainedAudioFormat":null,
      "playbackPositionSeconds":\(playbackPositionSeconds),"listenCount":0,"finishCount":0,
      "lastListenedAt":\(quoted(lastListenedAt))}
      """
    return try JSONDecoder().decode(SavedSet.self, from: Data(json.utf8))
  }

  /// A JSON string, or null when the field is absent.
  private func quoted(_ value: String?) -> String {
    value.map { "\"\($0)\"" } ?? "null"
  }

  func testTagCountsCountEachSetOncePerTag() throws {
    let counts = SetPresentation.tagCounts([
      try makeSet(id: "a", tags: #"["techno","house"]"#),
      try makeSet(id: "b", tags: #"["techno","techno"]"#),
      try makeSet(id: "c", tags: #"[]"#),
    ])
    XCTAssertEqual(counts, ["techno": 2, "house": 1])
  }

  func testContinueListeningHoldsStartedSetsMostRecentFirst() throws {
    let sets = [
      try makeSet(id: "untouched", durationSeconds: 3600),
      try makeSet(
        id: "older", playbackPositionSeconds: 600, durationSeconds: 3600,
        lastListenedAt: "2026-09-10T20:00:00.000Z"),
      try makeSet(
        id: "finished", playbackPositionSeconds: 3600, durationSeconds: 3600,
        lastListenedAt: "2026-09-12T20:00:00.000Z"),
      try makeSet(
        id: "newer", playbackPositionSeconds: 60, durationSeconds: 3600,
        lastListenedAt: "2026-09-11T20:00:00.000Z"),
      try makeSet(id: "unmeasured", playbackPositionSeconds: 30),
    ]
    XCTAssertEqual(
      SetPresentation.continueListening(sets).map(\.id), ["newer", "older", "unmeasured"])
    XCTAssertEqual(SetPresentation.continueListening(sets, limit: 1).map(\.id), ["newer"])
  }

  func testTheDownloadControlFollowsTheLiveState() {
    let live = { (state: String, received: Int, total: Int?) in
      AudioState(state: state, bytesReceived: received, bytesTotal: total, format: nil)
    }
    // The Set still says queued; the watch already sees bytes arriving.
    XCTAssertEqual(
      SetPresentation.downloadPhase("queued", live: live("downloading", 42, 100)), .downloading(0.42))
    XCTAssertEqual(
      SetPresentation.downloadPhase("queued", live: live("downloading", 0, nil)), .downloading(nil))
    XCTAssertEqual(SetPresentation.downloadPhase("queued", live: nil), .queued)
    // Finished, before the library is read again: a full bar rather than a step back.
    XCTAssertEqual(
      SetPresentation.downloadPhase("queued", live: live("ready", 99, 99)), .downloading(1))
    XCTAssertEqual(SetPresentation.downloadPhase("failed", live: nil), .failed)
    XCTAssertEqual(SetPresentation.downloadPhase("canceled", live: nil), .failed)
    XCTAssertEqual(SetPresentation.downloadPhase("none", live: nil), .available)
  }

  /// The artwork's control exists only where there is Retained Audio, and for the Set in the
  /// player it names the change it makes rather than the state it is in.
  func testRowPlaybackFollowsRetainedAudioAndThePlayer() throws {
    XCTAssertNil(
      SetPresentation.playback(of: try makeSet(), currentSetId: "one", isPlaying: true),
      "a Set without Retained Audio has nothing to play")
    let kept = try makeSet(downloadState: "ready")
    XCTAssertEqual(SetPresentation.playback(of: kept, currentSetId: nil, isPlaying: false), .ready)
    XCTAssertEqual(SetPresentation.playback(of: kept, currentSetId: "two", isPlaying: true), .ready)
    XCTAssertEqual(SetPresentation.playback(of: kept, currentSetId: "one", isPlaying: true), .playing)
    XCTAssertEqual(SetPresentation.playback(of: kept, currentSetId: "one", isPlaying: false), .paused)
  }

  func testDateParsesWithAndWithoutFractionalSeconds() {
    XCTAssertEqual(
      SetPresentation.date(from: "2026-09-11T02:33:14.729Z").timeIntervalSince1970,
      1_789_093_994.729,
      accuracy: 0.01
    )
    XCTAssertEqual(
      SetPresentation.date(from: "2026-09-11T02:33:14Z").timeIntervalSince1970,
      1_789_093_994,
      accuracy: 0.01
    )
    XCTAssertEqual(SetPresentation.date(from: "not a date"), .distantPast)
  }
}
