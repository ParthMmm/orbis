import AVFoundation
import MediaPlayer
import XCTest

@testable import Orbis

/// Audio downloads and streaming, end to end at the seams: the client speaks the four
/// audio routes, the model carries download state into the library, and the player
/// builds an authenticated asset and publishes Now Playing without ever playing
/// network audio inside a test.
@MainActor
final class AudioDownloadTests: XCTestCase {
  /// Pure string builders, callable from the stub responder's nonisolated closure.
  nonisolated private static func setJSON(id: String, state: String) -> String {
    """
    {"id":"\(id)","url":"https://www.youtube.com/watch?v=abcdefghijk",
    "title":"Seeded set","source":"youtube","tags":[],"createdAt":"2026-01-01T00:00:00.000Z",
    "creator":null,"artworkUrl":null,"durationSeconds":5400,"metadataState":"enriched",
    "downloadState":"\(state)","playlistIds":[],"playbackPositionSeconds":0,"listenCount":0,
    "finishCount":0,"lastListenedAt":null}
    """
  }

  nonisolated private static func libraryJSON(state: String) -> String {
    "{\"sets\":[\(setJSON(id: "1", state: state))]}"
  }

  private func client() -> OrbisClient {
    OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: StubProtocol.session(responder: { request in
        switch (request.httpMethod, request.url?.path()) {
        case ("POST", "/sets/1/audio/download"):
          (202, Self.setJSON(id: "1", state: "queued"))
        case ("GET", "/sets/1/audio/state"):
          (
            200,
            "{\"state\":\"downloading\",\"bytesReceived\":10,\"bytesTotal\":100,\"format\":null}"
          )
        case ("DELETE", "/sets/1/audio/download"):
          (200, Self.setJSON(id: "1", state: "none"))
        default:
          (404, "{\"message\":\"Set not found.\"}")
        }
      })
    )
  }

  func testRequestDownloadHitsRouteAndDecodesSet() async throws {
    let updated = try await client().requestAudioDownload("1")
    XCTAssertEqual(updated.downloadState, "queued")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "POST")
    XCTAssertEqual(StubProtocol.lastRequest?.url?.path(), "/sets/1/audio/download")
  }

  func testAudioStateDecodesProgress() async throws {
    let state = try await client().audioState("1")
    XCTAssertEqual(state.state, "downloading")
    XCTAssertEqual(state.bytesReceived, 10)
    XCTAssertEqual(state.bytesTotal, 100)
    XCTAssertNil(state.format)
  }

  func testCancelDownloadDecodesSet() async throws {
    let updated = try await client().cancelAudioDownload("1")
    XCTAssertEqual(updated.downloadState, "none")
    XCTAssertEqual(StubProtocol.lastRequest?.httpMethod, "DELETE")
  }

  func testAudioFileURLShapesPath() {
    let url = client().audioFileURL("1")
    XCTAssertEqual(url.absoluteString, "https://vanta.example.ts.net/sets/1/audio")
  }

  func testDownloadUpdatesLibraryState() async throws {
    let model = AppModel(
      client: client(), settings: MemoryClientSettings()
    )
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self,
        from: Data(Self.setJSON(id: "1", state: "none").utf8)
      )
    ])
    await model.downloadAudio("1")
    XCTAssertEqual(model.savedSet("1")?.downloadState, "queued")
    XCTAssertNil(model.setFailure)
  }

  func testFailedDownloadSurfacesPageFailure() async throws {
    let failing = OrbisClient(
      address: URL(string: "https://vanta.example.ts.net")!,
      token: "token",
      session: StubProtocol.session(status: 500, body: "{}")
    )
    let model = AppModel(client: failing, settings: MemoryClientSettings())
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self,
        from: Data(Self.setJSON(id: "1", state: "none").utf8)
      )
    ])
    await model.downloadAudio("1")
    XCTAssertNotNil(model.setFailure)
    XCTAssertEqual(model.savedSet("1")?.downloadState, "none")
  }

  func testRefreshStoresProgressAndReloadsOnTerminal() async throws {
    func modelForResponder(
      _ responder: @Sendable @escaping (URLRequest) -> (Int, String)
    ) throws -> AppModel {
      let client = OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(responder: responder)
      )
      let model = AppModel(client: client, settings: MemoryClientSettings())
      model.library = .loaded([
        try JSONDecoder().decode(
          SavedSet.self,
          from: Data(Self.setJSON(id: "1", state: "downloading").utf8)
        )
      ])
      return model
    }
    let running = try modelForResponder { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("GET", "/sets/1/audio/state"):
        (
          200,
          "{\"state\":\"downloading\",\"bytesReceived\":10,\"bytesTotal\":100,\"format\":null}"
        )
      case ("GET", "/sets"):
        (200, Self.libraryJSON(state: "downloading"))
      default:
        (404, "{\"message\":\"Set not found.\"}")
      }
    }
    await running.refreshAudioState("1")
    XCTAssertEqual(running.audioStates["1"]?.bytesReceived, 10)
    XCTAssertEqual(running.savedSet("1")?.downloadState, "downloading")
    let finished = try modelForResponder { request in
      switch (request.httpMethod, request.url?.path()) {
      case ("GET", "/sets/1/audio/state"):
        (
          200,
          "{\"state\":\"ready\",\"bytesReceived\":99,\"bytesTotal\":99,\"format\":\"mp3\"}"
        )
      case ("GET", "/sets"):
        (200, Self.libraryJSON(state: "ready"))
      default:
        (404, "{\"message\":\"Set not found.\"}")
      }
    }
    await finished.refreshAudioState("1")
    XCTAssertNil(finished.audioStates["1"])
    XCTAssertEqual(finished.savedSet("1")?.downloadState, "ready")
  }

  func testPlayerAssetCarriesBearerToken() {
    let options = AudioPlayer.assetOptions(token: "secret-token")
    let fields = options[AudioPlayer.assetHeaderFieldsKey] as? [String: String]
    XCTAssertEqual(fields?["Authorization"], "Bearer secret-token")
  }

  func testPlayerBuildsFileURLFromSetID() {
    // The player once loaded the service root, which answers 404, instead of the
    // Set's file: this pins the exact URL play() hands the asset, with and
    // without a trailing slash on the service address.
    for base in [
      "https://vanta.example.ts.net:8444", "https://vanta.example.ts.net:8444/",
    ] {
      XCTAssertEqual(
        AudioPlayer.fileURL(setID: "1", baseURL: URL(string: base)!).absoluteString,
        "https://vanta.example.ts.net:8444/sets/1/audio"
      )
    }
  }

  func testNowPlayingInfoHasTitleDurationAndRate() {
    let playing = AudioPlayer.nowPlayingInfo(
      title: "Seeded set", duration: 5400, elapsed: 12, isPlaying: true
    )
    XCTAssertEqual(playing[MPMediaItemPropertyTitle] as? String, "Seeded set")
    XCTAssertEqual(
      playing[MPMediaItemPropertyPlaybackDuration] as? TimeInterval, 5400
    )
    XCTAssertEqual(
      playing[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? TimeInterval, 12
    )
    XCTAssertEqual(playing[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1.0)
    let paused = AudioPlayer.nowPlayingInfo(
      title: "Seeded set", duration: nil, elapsed: 12, isPlaying: false
    )
    XCTAssertEqual(paused[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0.0)
    XCTAssertNil(paused[MPMediaItemPropertyPlaybackDuration])
  }

  func testRemoteCommandsRegisteredAndEnabled() {
    do {
      // The player keeps its command targets alive; leaving the scope tears them
      // down again so no test leaks a handler into the next one.
      let player = AudioPlayer()
      _ = player
      XCTAssertTrue(MPRemoteCommandCenter.shared().playCommand.isEnabled)
      XCTAssertTrue(MPRemoteCommandCenter.shared().pauseCommand.isEnabled)
    }
    XCTAssertFalse(MPRemoteCommandCenter.shared().playCommand.isEnabled)
    XCTAssertFalse(MPRemoteCommandCenter.shared().pauseCommand.isEnabled)
  }

  /// A download is watched by the model rather than by the page that asked for it, so a download
  /// that the service finishes while the person is somewhere else still lands in the Library.
  /// Nothing here polls the page: this is the watch doing the work on its own.
  func testADownloadThatFinishesElsewhereStillLandsInTheLibrary() async throws {
    let model = AppModel(
      client: OrbisClient(
        address: URL(string: "https://vanta.example.ts.net")!,
        token: "token",
        session: StubProtocol.session(responder: { request in
          switch (request.httpMethod, request.url?.path()) {
          case ("POST", "/sets/1/audio/download"):
            (202, Self.setJSON(id: "1", state: "queued"))
          case ("GET", "/sets/1/audio/state"):
            (200, "{\"state\":\"ready\",\"bytesReceived\":99,\"bytesTotal\":99,\"format\":\"mp3\"}")
          case ("GET", "/sets"):
            (200, Self.libraryJSON(state: "ready"))
          default:
            (404, "{\"message\":\"Set not found.\"}")
          }
        })
      ), settings: MemoryClientSettings())
    model.library = .loaded([
      try JSONDecoder().decode(
        SavedSet.self, from: Data(Self.setJSON(id: "1", state: "none").utf8))
    ])

    await model.downloadAudio("1")

    var waited = 0
    while model.savedSet("1")?.downloadState != "ready", waited < 200 {
      try await Task.sleep(for: .milliseconds(20))
      waited += 1
    }
    XCTAssertEqual(
      model.savedSet("1")?.downloadState, "ready",
      "the watch must land a finished download in the Library without the page asking again")
    XCTAssertNil(model.audioStates["1"], "a finished download holds no running progress")
  }
}
