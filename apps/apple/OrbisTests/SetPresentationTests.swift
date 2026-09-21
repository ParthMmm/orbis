import OrbisDesign
import XCTest

@testable import Orbis

@MainActor
final class SetPresentationTests: XCTestCase {
  private func makeSet(
    url: String = "https://www.youtube.com/watch?v=abcdefghijk",
    title: String = "Night session",
    tags: String = #"["techno","breaks"]"#,
    createdAt: String = "2026-09-11T02:33:14.729Z",
    playbackPositionSeconds: Int = 0,
    durationSeconds: Int? = nil,
    artworkUrl: String? = nil,
    artworkLargeUrl: String? = nil,
    downloadState: String = "none"
  ) throws -> SavedSet {
    let json = """
      {"id":"one","url":"\(url)","title":"\(title)","source":"youtube","tags":\(tags),
      "createdAt":"\(createdAt)","creator":null,"artworkUrl":\(quoted(artworkUrl)),
      "artworkLargeUrl":\(quoted(artworkLargeUrl)),"durationSeconds":\(durationSeconds.map(String.init) ?? "null"),
      "metadataState":"pending","titleEditedByUser":false,"downloadState":"\(downloadState)",
      "playlistIds":[],"retainedAudioBytes":null,"retainedAudioFormat":null,
      "playbackPositionSeconds":\(playbackPositionSeconds),"listenCount":0,"finishCount":0,
      "lastListenedAt":null}
      """
    return try JSONDecoder().decode(SavedSet.self, from: Data(json.utf8))
  }

  /// A JSON string, or null when the field is absent.
  private func quoted(_ value: String?) -> String {
    value.map { "\"\($0)\"" } ?? "null"
  }

  func testThePageDrawsTheLargestImageTheProviderOffered() throws {
    XCTAssertEqual(
      SetPresentation.pageArtwork(
        try makeSet(
          artworkUrl: "https://example.test/listing.jpg",
          artworkLargeUrl: "https://example.test/large.jpg"
        )
      )?.absoluteString,
      "https://example.test/large.jpg")
    // A service that predates the second image sends one, and the page still has an image.
    XCTAssertEqual(
      SetPresentation.pageArtwork(try makeSet(artworkUrl: "https://example.test/listing.jpg"))?
        .absoluteString,
      "https://example.test/listing.jpg")
    XCTAssertNil(SetPresentation.pageArtwork(try makeSet()))
  }

  func testRowCarriesIdentitySourceTagsAndDate() throws {
    let model = SetPresentation.row(try makeSet())

    XCTAssertEqual(model.source, "YouTube")
    XCTAssertEqual(model.title, "Night session")
    XCTAssertEqual(model.tags.map(\.name), ["techno", "breaks"])
    XCTAssertEqual(model.added.timeIntervalSince1970, 1_789_093_994.729, accuracy: 0.01)
  }

  func testProgressNeedsALengthToMeasureAgainst() throws {
    XCTAssertNil(SetPresentation.progress(of: try makeSet(playbackPositionSeconds: 600)))
    XCTAssertEqual(
      SetPresentation.progress(of: try makeSet(playbackPositionSeconds: 600, durationSeconds: 2400)), 0.25)
    XCTAssertEqual(
      SetPresentation.progress(of: try makeSet(playbackPositionSeconds: 9000, durationSeconds: 2400)), 1)
  }

  func testDisplayURLCarriesNoSchemeOrWWW() {
    XCTAssertEqual(SetPresentation.displayURL("https://www.youtube.com/watch?v=x"), "youtube.com/watch?v=x")
    XCTAssertEqual(SetPresentation.displayURL("http://soundcloud.com/a/b"), "soundcloud.com/a/b")
    XCTAssertEqual(SetPresentation.displayURL("https://vanta.tail01d084.ts.net/sets"), "vanta.tail01d084.ts.net/sets")
  }

  func testTagColourIsStableAndIndependentOfOtherTags() throws {
    let alone = SetPresentation.row(try makeSet(tags: #"["techno"]"#))
    let mixed = SetPresentation.row(try makeSet(tags: #"["breaks","techno"]"#))

    let technoAlone = alone.tags.first { $0.name == "techno" }?.category
    let technoMixed = mixed.tags.first { $0.name == "techno" }?.category

    XCTAssertEqual(SetPresentation.category(for: "techno"), SetPresentation.category(for: "techno"))
    XCTAssertEqual(technoAlone, technoMixed)
    XCTAssertNotEqual(
      SetPresentation.category(for: "techno"),
      SetPresentation.category(for: "breaks")
    )
  }

  func testStateAppearsOnlyWhenThereIsSomethingToSay() throws {
    XCTAssertNil(SetPresentation.row(try makeSet()).state)
    XCTAssertNil(SetPresentation.row(try makeSet(downloadState: "none")).state)

    let both = try XCTUnwrap(
      SetPresentation.row(try makeSet(playbackPositionSeconds: 3661, downloadState: "queued")).state
    )
    XCTAssertEqual(both.resumeAt, 3661)
    XCTAssertEqual(both.label, "Resume at 1:01:01 · Download queued")

    let downloadOnly = try XCTUnwrap(
      SetPresentation.row(try makeSet(downloadState: "ready")).state
    )
    XCTAssertNil(downloadOnly.resumeAt)
    XCTAssertNil(downloadOnly.download, "kept audio is a symbol on the row, not a line of words")
    XCTAssertTrue(downloadOnly.kept)
    XCTAssertEqual(downloadOnly.label, "Audio kept")
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

  func testDownloadLabelsCoverEveryServerState() {
    XCTAssertNil(SetPresentation.downloadLabel("none"))
    XCTAssertEqual(SetPresentation.downloadLabel("queued"), "Download queued")
    XCTAssertEqual(SetPresentation.downloadLabel("downloading"), "Downloading")
    XCTAssertEqual(SetPresentation.downloadLabel("ready"), "Audio ready")
    XCTAssertEqual(SetPresentation.downloadLabel("failed"), "Download failed")
    XCTAssertEqual(SetPresentation.downloadLabel("canceled"), "Download canceled")
    XCTAssertNil(SetPresentation.downloadLabel("something-new"))
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
