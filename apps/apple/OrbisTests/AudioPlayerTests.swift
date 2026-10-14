import AVFoundation
import Foundation
import XCTest

@testable import Orbis

/// What a press does while the audio session is still coming up, or after it has gone. Each test
/// holds the session's activation open, presses a button, then lets the session answer, and reads
/// the rate the player was asked for.
///
/// No test makes a sound: the audio address is one no host answers, so the item never loads, and
/// a requested rate of 1 is the evidence that the player was told to play.
@MainActor
final class AudioPlayerTests: XCTestCase {
  /// A session whose activation waits until the test lets it answer.
  final class SessionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [CheckedContinuation<Bool, Never>] = []
    private var starts = 0
    /// Set once a wait times out, so every activation answers at once and a failing test ends
    /// instead of hanging on a continuation nobody resumes.
    private var isOpen = false

    var startCount: Int { lock.withLock { starts } }

    var session: AudioPlayer.Session {
      AudioPlayer.Session(start: { await self.start() }, end: {})
    }

    private func start() async -> Bool {
      await withCheckedContinuation { continuation in
        let answersNow = lock.withLock {
          starts += 1
          if !isOpen { waiting.append(continuation) }
          return isOpen
        }
        if answersNow { continuation.resume(returning: true) }
      }
    }

    /// Waits until the player has asked for the session `count` times in all.
    func waitForStart(_ count: Int = 1) async {
      let deadline = ContinuousClock.now + .seconds(5)
      while startCount < count, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(5))
      }
      guard startCount < count else { return }
      XCTFail("the player asked for the session \(startCount) times, not \(count)")
      lock.withLock { isOpen = true }
      release()
    }

    /// Answers every activation waiting now.
    func release(_ activated: Bool = true) {
      let pending = lock.withLock {
        let pending = waiting
        waiting.removeAll()
        return pending
      }
      for continuation in pending { continuation.resume(returning: activated) }
    }
  }

  /// An address in a block no host answers, so the item waits and never sounds.
  private let silentAddress = URL(string: "http://10.255.255.1:9")!

  private func set(id: String = "1") -> SavedSet {
    SavedSet(
      id: id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Night session",
      source: .youtube,
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: nil,
      creator: nil,
      artworkUrl: nil,
      artworkLargeUrl: nil,
      durationSeconds: nil,
      metadataState: "enriched",
      downloadState: "ready",
      playlistIds: [],
      playbackPositionSeconds: 0,
      listenCount: 0,
      finishCount: 0,
      lastListenedAt: nil
    )
  }

  private func rate(_ player: AudioPlayer) -> Float {
    player.player?.rate ?? 0
  }

  /// Race 1: a pause that lands while the session is still activating must hold once the session
  /// answers.
  func testAPauseWhileTheSessionStartsIsKept() async {
    let gate = SessionGate()
    let player = AudioPlayer(session: gate.session)
    player.play(set: set(), baseURL: silentAddress, token: "token")
    await gate.waitForStart()

    player.pause()
    gate.release()
    await player.sessionWork?.value

    XCTAssertEqual(rate(player), 0, "the player was told to play after the pause")
    XCTAssertEqual(player.state, .paused)
    player.stop()
  }

  /// Race 1, through the mini player's button: pressing it while the Set loads is a pause. This
  /// one goes through the model with the system's own session, which answers on a later turn.
  func testTheMiniPlayerToggleWhileLoadingPauses() async {
    let client = OrbisClient(
      address: silentAddress,
      token: "token",
      session: StubProtocol.session(status: 200, body: "{}")
    )
    let model = AppModel(client: client, settings: MemoryClientSettings())
    let player = model.audioPlayer
    player.play(set: set(), baseURL: silentAddress, token: "token")
    XCTAssertEqual(player.state, .loading)

    model.togglePlayback()
    await player.sessionWork?.value

    XCTAssertEqual(rate(player), 0, "the toggle while loading let the audio start")
    XCTAssertEqual(player.state, .paused)
    player.stop()
  }

  /// Race 3: a resume must wait for the session. Pausing during the start and resuming before the
  /// session answers leaves the player quiet until it does.
  func testAResumeWaitsForTheSession() async {
    let gate = SessionGate()
    let player = AudioPlayer(session: gate.session)
    player.play(set: set(), baseURL: silentAddress, token: "token")
    await gate.waitForStart()
    player.pause()

    player.resume()
    XCTAssertEqual(rate(player), 0, "the resume played before the session was active")

    gate.release()
    await gate.waitForStart(2)
    XCTAssertEqual(rate(player), 0, "the start before the resume played ahead of it")
    gate.release()
    await player.sessionWork?.value
    XCTAssertEqual(rate(player), 1)
    player.stop()
  }

  /// Race 3, after the session failed: a resume asks for the session again rather than playing
  /// without one.
  func testAResumeAfterAFailedSessionAsksForTheSessionAgain() async {
    let gate = SessionGate()
    let player = AudioPlayer(session: gate.session)
    player.play(set: set(), baseURL: silentAddress, token: "token")
    await gate.waitForStart()
    gate.release(false)
    await player.sessionWork?.value
    XCTAssertEqual(player.state, .failed("Audio could not start on this device."))

    player.resume()
    XCTAssertEqual(rate(player), 0, "the resume played without an active session")
    await gate.waitForStart(2)
    gate.release()
    await player.sessionWork?.value
    XCTAssertEqual(rate(player), 1)
    player.stop()
  }

  /// A start that fails while a later one waits behind it must not decide the outcome: the later
  /// press is what the person asked for last.
  func testAFailedStartDoesNotOverrideTheStartQueuedBehindIt() async {
    let gate = SessionGate()
    let player = AudioPlayer(session: gate.session)
    player.play(set: set(), baseURL: silentAddress, token: "token")
    await gate.waitForStart()
    player.pause()
    player.resume()

    gate.release(false)
    await gate.waitForStart(2)
    gate.release()
    await player.sessionWork?.value

    XCTAssertEqual(rate(player), 1, "the earlier failure left the resumed Set quiet")
    XCTAssertEqual(player.state, .loading)
    player.stop()
  }

  #if !os(macOS)
    private func interrupt(_ type: AVAudioSession.InterruptionType, shouldResume: Bool = false) {
      var info: [AnyHashable: Any] = [AVAudioSessionInterruptionTypeKey: type.rawValue]
      if shouldResume {
        info[AVAudioSessionInterruptionOptionKey] =
          AVAudioSession.InterruptionOptions.shouldResume.rawValue
      }
      NotificationCenter.default.post(
        name: AVAudioSession.interruptionNotification, object: nil, userInfo: info)
    }

    /// An interruption that ends with "should resume" brings back only a Set that was playing
    /// when it began. A Set the person had paused stays paused.
    func testTheEndOfAnInterruptionLeavesAPausedSetPaused() async {
      let gate = SessionGate()
      let player = AudioPlayer(session: gate.session)
      player.play(set: set(), baseURL: silentAddress, token: "token")
      await gate.waitForStart()
      gate.release()
      await player.sessionWork?.value
      player.pause()

      interrupt(.began)
      interrupt(.ended, shouldResume: true)
      // A resume would ask for the session again; give it the chance to.
      try? await Task.sleep(for: .milliseconds(100))
      gate.release()
      await player.sessionWork?.value

      XCTAssertEqual(rate(player), 0, "the end of the interruption played a paused Set")
      XCTAssertEqual(player.state, .paused)
      player.stop()
    }

    /// A Set that was playing when the interruption began comes back through the session.
    func testTheEndOfAnInterruptionResumesThroughTheSession() async {
      let gate = SessionGate()
      let player = AudioPlayer(session: gate.session)
      player.play(set: set(), baseURL: silentAddress, token: "token")
      await gate.waitForStart()
      gate.release()
      await player.sessionWork?.value
      XCTAssertEqual(rate(player), 1)

      interrupt(.began)
      try? await Task.sleep(for: .milliseconds(50))
      XCTAssertEqual(rate(player), 0)
      interrupt(.ended, shouldResume: true)
      try? await Task.sleep(for: .milliseconds(50))
      XCTAssertEqual(rate(player), 0, "the end of the interruption played before the session")
      await gate.waitForStart(2)
      gate.release()
      await player.sessionWork?.value

      XCTAssertEqual(rate(player), 1)
      player.stop()
    }

    /// When the system interrupts, AVPlayer drops its own rate, and that change can reach the
    /// player before the interruption notification does. A stop the person did not ask for is not
    /// their pause, so the end of the interruption still brings the Set back.
    func testAnInterruptionThatArrivesAfterTheRateDropStillResumes() async {
      let gate = SessionGate()
      let player = AudioPlayer(session: gate.session)
      player.play(set: set(), baseURL: silentAddress, token: "token")
      await gate.waitForStart()
      gate.release()
      await player.sessionWork?.value
      // The unloaded item cannot report playing, so the changes it would make are applied here.
      player.stallChanged(status: .playing)
      XCTAssertEqual(player.state, .playing)

      // The system stops the player first.
      player.rateChanged(rate: 0)
      player.stallChanged(status: .paused)
      interrupt(.began)
      try? await Task.sleep(for: .milliseconds(50))
      interrupt(.ended, shouldResume: true)
      try? await Task.sleep(for: .milliseconds(50))

      XCTAssertEqual(player.state, .loading, "the end of the interruption did not resume")
      await gate.waitForStart(2)
      gate.release()
      await player.sessionWork?.value
      XCTAssertEqual(rate(player), 1)
      player.stop()
    }
  #endif
}
