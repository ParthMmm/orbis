import Foundation
import XCTest

@testable import Orbis

/// The Listening Queue is what makes playback shared state: playing makes a Set active on the
/// service, and the queue that comes back is what the app shows. These tests assert the request
/// each action makes and the state that follows it.
@MainActor
final class QueueTests: XCTestCase {
  /// Every request a model made, in order. `StubProtocol` keeps only the last one, and the order
  /// matters to a test that finishes a Set and watches what starts next.
  final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ request: URLRequest) {
      lock.withLock {
        entries.append("\(request.httpMethod ?? "") \(request.url?.path() ?? "")")
      }
    }

    var all: [String] { lock.withLock { entries } }
  }

  private nonisolated static func set(
    id: String,
    position: Int = 0,
    downloadState: String = "ready"
  ) -> String {
    """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=\(id)abcdefg","title":"Set \(id)",
    "source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z","creator":null,
    "artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"\(downloadState)","playlistIds":[],"playbackPositionSeconds":\(position),
    "listenCount":0,"finishCount":0,"lastListenedAt":null}
    """
  }

  private nonisolated static func queueBody(active: String?, entries: [String]) -> String {
    let activeJson = active.map { "\"\($0)\"" } ?? "null"
    return "{\"queue\":{\"activeSetId\":\(activeJson),\"entries\":[\(entries.joined(separator: ","))]}}"
  }

  /// The JSON a request carried, as fields, because `JSONEncoder` decides the order of keys and a
  /// test that compares raw text is testing the encoder rather than the request.
  private func body(_ data: Data?) -> [String: String] {
    guard let data,
      let fields = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else { return [:] }
    return fields
  }

  private func model(
    log: RequestLog? = nil,
    responder: @Sendable @escaping (URLRequest) -> (Int, String)
  ) -> AppModel {
    let client = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: StubProtocol.session(responder: { request in
        log?.record(request)
        return responder(request)
      })
    )
    return AppModel(client: client, settings: MemoryClientSettings())
  }

  private func queue(_ model: AppModel) -> ListeningQueue? {
    guard case .loaded(let loaded) = model.queue else { return nil }
    return loaded
  }

  func testPlayingASetMakesItTheActiveEntry() async {
    let model = model { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("PUT", "/queue/active"):
        return (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")]))
      default:
        return (200, "{}")
      }
    }

    await model.playSet("a")

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/queue/active")
    XCTAssertEqual(body(StubProtocol.lastBody), ["setId": "a"])
    XCTAssertEqual(queue(model)?.activeSetId, "a")
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["a"])
  }

  func testPlayNextIsSentAsAnInsertAfterTheActiveSet() async {
    let model = model { request in
      if request.url?.path() == "/queue/entries" {
        return (
          201,
          Self.queueBody(
            active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }

    await model.playNext("b")

    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/queue/entries")
    XCTAssertEqual(body(StubProtocol.lastBody), ["placement": "next", "setId": "b"])
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["a", "b"])
    XCTAssertEqual(model.queueNotice, "Plays next")
  }

  func testAddToQueueIsSentAsAnAppend() async {
    let model = model { request in
      if request.url?.path() == "/queue/entries" {
        return (
          201,
          Self.queueBody(
            active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }

    await model.addToQueue("b")

    XCTAssertEqual(body(StubProtocol.lastBody), ["placement": "end", "setId": "b"])
    XCTAssertEqual(model.queueNotice, "Added to the queue")
  }

  func testPlayingAPlaylistReplacesTheQueue() async {
    let model = model { request in
      if request.url?.path() == "/queue/playlist" {
        return (
          200,
          Self.queueBody(active: "a", entries: [Self.set(id: "a"), Self.set(id: "b")])
        )
      }
      return (200, "{}")
    }

    await model.playPlaylist("closing")

    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/queue/playlist")
    XCTAssertEqual(body(StubProtocol.lastBody), ["playlistId": "closing"])
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["a", "b"])
  }

  func testAPlaylistWithNothingPlayableStopsPlayback() async {
    let model = model { request in
      if request.url?.path() == "/queue/playlist" {
        return (200, Self.queueBody(active: nil, entries: []))
      }
      return (200, "{}")
    }

    await model.playPlaylist("empty")

    XCTAssertEqual(queue(model)?.activeSetId, nil)
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  func testARefusedQueueActionSaysWhatTheServiceSaid() async {
    let model = model { _ in
      (400, #"{"message":"Only sets with audio can be added to the queue."}"#)
    }

    await model.playNext("d")

    XCTAssertEqual(
      model.setFailure?.message.contains("Only sets with audio can be added to the queue."),
      true)
  }

  func testFinishingASetStartsTheNextEntry() async {
    let log = RequestLog()
    let model = model(log: log) { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("POST", "/queue/completion"):
        return (200, Self.queueBody(active: "b", entries: [Self.set(id: "b")]))
      case ("GET", "/sets"):
        return (200, "{\"sets\":[\(Self.set(id: "b"))]}")
      default:
        return (200, "{}")
      }
    }

    await model.finishedPlaying("a")

    XCTAssertTrue(log.all.contains("POST /queue/completion"))
    XCTAssertTrue(log.all.contains("GET /sets"))
    XCTAssertEqual(queue(model)?.activeSetId, "b")
  }

  func testAnEmptyQueueAfterAFinishLeavesNothingPlaying() async {
    let model = model { request in
      if request.url?.path() == "/queue/completion" {
        return (200, Self.queueBody(active: nil, entries: []))
      }
      if request.url?.path() == "/sets" {
        return (200, #"{"sets":[]}"#)
      }
      return (200, "{}")
    }

    await model.finishedPlaying("a")

    XCTAssertNil(queue(model)?.activeSetId)
    XCTAssertNil(model.audioPlayer.currentSetId)
  }

  func testTheQueueIsReadAgainWhenASetIsRemoved() async {
    let log = RequestLog()
    let model = model(log: log) { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("DELETE", "/sets/a"):
        return (200, Self.set(id: "a"))
      case ("GET", "/queue"):
        return (200, Self.queueBody(active: nil, entries: [Self.set(id: "b")]))
      default:
        return (200, "{}")
      }
    }

    await model.remove("a")

    XCTAssertEqual(log.all, ["DELETE /sets/a", "GET /queue"])
    XCTAssertEqual(queue(model)?.entries.map(\.id), ["b"])
  }

  func testAQueueThatCannotBeReadSaysWhyAndCanBeRetried() async {
    let model = model { _ in (500, #"{"message":"Could not complete the library request."}"#) }

    await model.loadQueue()

    guard case .failed(let failure) = model.queue else {
      return XCTFail("a failed read should keep its reason")
    }
    XCTAssertTrue(failure.message.contains("Could not complete the library request."))
  }

  func testForgettingTheDeviceClearsTheQueue() async {
    let model = model { _ in (200, Self.queueBody(active: "a", entries: [Self.set(id: "a")])) }
    await model.loadQueue()
    XCTAssertEqual(queue(model)?.activeSetId, "a")

    model.forget()

    XCTAssertNil(queue(model))
    if case .idle = model.queue {
    } else {
      XCTFail("the queue belonged to the service that was forgotten")
    }
    XCTAssertNil(model.queueNotice)
  }

  func testNothingIsPlayingUntilSomethingIs() async {
    let model = model { _ in (200, "{}") }

    // Replacing the queue asks a question only when a Set is playing now, which this is the rule
    // the Library reads.
    XCTAssertFalse(model.isPlayingNow)
  }

  func testASetResumesFromItsStoredPosition() {
    let heard = SavedSet(
      id: "a",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Night session",
      source: .youtube,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      creator: nil,
      artworkUrl: nil,
      durationSeconds: 5400,
      metadataState: "enriched",
      downloadState: "ready",
      playlistIds: [],
      playbackPositionSeconds: 300,
      listenCount: 1,
      finishCount: 0,
      lastListenedAt: nil
    )

    XCTAssertEqual(heard.resumePosition, 300)
  }
}
