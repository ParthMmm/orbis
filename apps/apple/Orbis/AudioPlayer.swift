import AVFoundation
import MediaPlayer

/// Plays one Set's retained audio, streamed from the service with the device token.
///
/// Everything here stays on the main actor: playback control is not CPU-bound, and
/// AVPlayer does its own threading. Observers that the system can call from any thread
/// capture plain values first and hop back here before touching state.
@MainActor
@Observable
final class AudioPlayer {
  enum PlaybackState: Equatable {
    case idle
    case loading
    case playing
    case paused
    case failed(String)
  }

  private(set) var state = PlaybackState.idle
  private(set) var currentSetId: String?
  private(set) var currentTitle = ""
  private(set) var elapsed: TimeInterval = 0
  private(set) var duration: TimeInterval?

  private var player: AVPlayer?
  private var timeObserver: Any?
  private var statusObservation: NSKeyValueObservation?
  private var rateObservation: NSKeyValueObservation?
  private var stallObservation: NSKeyValueObservation?
  private var commandTargets: [Any] = []
  private var observers: [NSObjectProtocol] = []
  private var isObservingInterruptions = false

  init() {
    setupCommands()
  }

  deinit {
    // A nonisolated deinit cannot touch MainActor state, so everything owned here
    // is released through stop(), which every play() enters through first. What
    // remains is global: the shared command center must not keep this player's
    // handlers after it is gone. Observation tokens invalidate themselves on
    // release, and the player itself only ever deallocates stopped or never played.
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.removeTarget(nil)
    center.pauseCommand.removeTarget(nil)
    center.playCommand.isEnabled = false
    center.pauseCommand.isEnabled = false
  }

  /// The header fields an asset needs so the service trusts the stream. The token
  /// travels here, never in the URL. The SDK no longer declares the key (it is gone
  /// from the Xcode 26 headers on every platform), so it is spelled as the literal
  /// string AVFoundation has always honored. If playback ever answers 401 where the
  /// same token works over URLSession, this key stopped being honored and the asset
  /// needs a resource-loader delegate instead.
  static let assetHeaderFieldsKey = "AVURLAssetHTTPHeaderFieldsKey"

  static func assetOptions(token: String) -> [String: Any] {
    [assetHeaderFieldsKey: ["Authorization": "Bearer \(token)"]]
  }

  static func asset(url: URL, token: String) -> AVURLAsset {
    AVURLAsset(url: url, options: assetOptions(token: token))
  }

  /// The Set's own audio file under the service address.
  static func fileURL(setID: String, baseURL: URL) -> URL {
    baseURL.appending(path: "sets/\(setID)/audio")
  }

  /// The Now Playing dictionary for a moment in time. Elapsed time and rate are set
  /// at play, pause, seek, and track change only: the system extrapolates between
  /// them, and a timer would only add jitter.
  static func nowPlayingInfo(
    title: String,
    duration: TimeInterval?,
    elapsed: TimeInterval,
    isPlaying: Bool
  ) -> [String: Any] {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
    ]
    if let duration {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    return info
  }

  func play(set: SavedSet, baseURL: URL, token: String) {
    stop()
    #if !os(macOS)
      do {
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try AVAudioSession.sharedInstance().setActive(true)
      } catch {
        state = .failed("Audio could not start on this device.")
        return
      }
    #endif
    currentSetId = set.id
    currentTitle = set.title
    elapsed = 0
    duration = nil
    state = .loading
    // The asset is the Set's own audio file, not the service root: loading the
    // root answers 404 and the player fails without ever asking for audio.
    let item = AVPlayerItem(
      asset: Self.asset(url: Self.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    // KVO can call back on any thread, so each handler captures plain values and
    // hops here before touching state.
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      let status = item.status
      let seconds = item.duration.seconds
      Task { @MainActor in
        self?.itemStatusChanged(status: status, durationSeconds: seconds)
      }
    }
    rateObservation = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
      let rate = player.rate
      Task { @MainActor in
        self?.rateChanged(rate: rate)
      }
    }
    stallObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
      let status = player.timeControlStatus
      Task { @MainActor in
        self?.stallChanged(status: status)
      }
    }
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      self?.elapsed = time.seconds
    }
    observeInterruptions()
    player.play()
    publishNowPlaying(isPlaying: true)
  }

  func pause() {
    player?.pause()
    publishNowPlaying(isPlaying: false)
    if case .playing = state {
      state = .paused
    }
  }

  func resume() {
    player?.play()
    publishNowPlaying(isPlaying: true)
  }

  func seek(to seconds: TimeInterval) {
    guard let duration, duration.isFinite else { return }
    let clamped = min(max(seconds, 0), duration)
    player?.seek(to: CMTime(seconds: clamped, preferredTimescale: 600))
    elapsed = clamped
    publishNowPlaying(isPlaying: state == .playing)
  }

  func stop() {
    player?.pause()
    dropPlayerObservers()
    player = nil
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
    isObservingInterruptions = false
    currentSetId = nil
    state = .idle
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    #if !os(macOS)
      try? AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
    #endif
  }

  private func itemStatusChanged(status: AVPlayerItem.Status, durationSeconds: Double) {
    switch status {
    case .readyToPlay:
      duration = durationSeconds.isFinite ? durationSeconds : nil
      publishNowPlaying(isPlaying: true)
    case .failed:
      state = .failed("This audio would not play.")
      publishNowPlaying(isPlaying: false)
    case .unknown:
      break
    @unknown default:
      break
    }
  }

  private func rateChanged(rate: Float) {
    switch state {
    case .playing where rate == 0:
      state = .paused
      publishNowPlaying(isPlaying: false)
    case .paused where rate > 0:
      state = .playing
      publishNowPlaying(isPlaying: true)
    default:
      break
    }
  }

  private func stallChanged(status: AVPlayer.TimeControlStatus) {
    switch status {
    case .playing:
      if state == .loading {
        state = .playing
      }
    case .paused:
      if state == .playing {
        state = .paused
      }
    case .waitingToPlayAtSpecifiedRate:
      if state == .playing || state == .loading {
        state = .loading
      }
    @unknown default:
      break
    }
  }

  private func publishNowPlaying(isPlaying: Bool) {
    guard !currentTitle.isEmpty else { return }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = Self.nowPlayingInfo(
      title: currentTitle,
      duration: duration,
      elapsed: elapsed,
      isPlaying: isPlaying
    )
  }

  private func dropPlayerObservers() {
    if let timeObserver {
      player?.removeTimeObserver(timeObserver)
      self.timeObserver = nil
    }
    statusObservation?.invalidate()
    rateObservation?.invalidate()
    stallObservation?.invalidate()
    statusObservation = nil
    rateObservation = nil
    stallObservation = nil
  }

  private func setupCommands() {
    let center = MPRemoteCommandCenter.shared()
    let play = center.playCommand.addTarget { [weak self] _ in
      self?.player?.play()
      self?.publishNowPlaying(isPlaying: true)
      return .success
    }
    center.playCommand.isEnabled = true
    let pause = center.pauseCommand.addTarget { [weak self] _ in
      self?.pause()
      return .success
    }
    center.pauseCommand.isEnabled = true
    commandTargets = [play, pause]
  }

  private func observeInterruptions() {
    guard !isObservingInterruptions else { return }
    isObservingInterruptions = true
    #if !os(macOS)
      let center = NotificationCenter.default
      // The observer block is nonisolated and Notification is not Sendable, so each
      // block extracts plain values first and only those cross into the hop below.
      observers.append(
        center.addObserver(
          forName: AVAudioSession.interruptionNotification,
          object: nil,
          queue: .main
        ) { [weak self] notification in
          guard let info = notification.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
          else { return }
          let shouldResume: Bool = {
            guard type == .ended,
              let rawOptions = info[AVAudioSessionInterruptionOptionKey] as? UInt
            else { return false }
            return AVAudioSession.InterruptionOptions(rawValue: rawOptions)
              .contains(.shouldResume)
          }()
          Task { @MainActor in
            self?.applyInterruption(type: type, shouldResume: shouldResume)
          }
        }
      )
      observers.append(
        center.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] notification in
          guard let info = notification.userInfo,
            let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
          else { return }
          let deviceLost = reason == .oldDeviceUnavailable
          Task { @MainActor in
            if deviceLost {
              self?.pause()
            }
          }
        }
      )
    #endif
  }

  #if !os(macOS)
    private func applyInterruption(
      type: AVAudioSession.InterruptionType, shouldResume: Bool
    ) {
      switch type {
      case .began:
        pause()
      case .ended:
        if shouldResume {
          player?.play()
          publishNowPlaying(isPlaying: true)
        }
      @unknown default:
        break
      }
    }
  #endif
}
