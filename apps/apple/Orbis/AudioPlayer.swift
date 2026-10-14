import AVFoundation
import MediaPlayer

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

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
  private(set) var currentArtist: String?
  private var cues: [Cue] = []
  var cueStarts: [TimeInterval] { cues.compactMap(\.startSeconds) }
  var currentCue: Cue? {
    cues.last { cue in cue.startSeconds.map { $0 <= elapsed } ?? false }
  }
  var nextCue: Cue? {
    cues.first { cue in cue.startSeconds.map { $0 > elapsed } ?? false }
  }
  private var currentArtwork: MPMediaItemArtwork?
  private var artworkFetch: Task<Void, Never>?
  private(set) var elapsed: TimeInterval = 0
  private(set) var duration: TimeInterval?

  private var player: AVPlayer?
  private var timeObserver: Any?
  private var statusObservation: NSKeyValueObservation?
  private var rateObservation: NSKeyValueObservation?
  private var stallObservation: NSKeyValueObservation?

  /// Where a resumed Set should start once its item is ready. AVPlayer refuses a seek before the
  /// item knows its own timeline, so the position waits here until it does.
  private var pendingSeek: TimeInterval?
  private var isSeeking = false

  @ObservationIgnored var onFinished: ((String) -> Void)?

  private var playbackGeneration = 0

  private var sessionWork: Task<Void, Never>?

  @ObservationIgnored nonisolated(unsafe) private var commandTargets: [Any] = []
  @ObservationIgnored nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
  private var isObservingInterruptions = false

  init() {
    setupCommands()
  }

  deinit {
    let center = MPRemoteCommandCenter.shared()
    let commands = [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
      center.skipBackwardCommand, center.skipForwardCommand,
    ]
    for command in commands {
      for target in commandTargets { command.removeTarget(target) }
      command.isEnabled = false
    }
    let notifications = NotificationCenter.default
    for observer in observers {
      notifications.removeObserver(observer)
    }
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

  static func fileURL(setID: String, baseURL: URL) -> URL {
    baseURL.appending(path: "sets/\(setID)/audio")
  }

  /// The Now Playing dictionary for a moment in time. Elapsed time and rate are set
  /// at play, pause, seek, and track change only: the system extrapolates between
  /// them, and a timer would only add jitter.
  static func nowPlayingInfo(
    title: String,
    artist: String? = nil,
    cue: Cue? = nil,
    artwork: MPMediaItemArtwork? = nil,
    duration: TimeInterval?,
    elapsed: TimeInterval,
    isPlaying: Bool
  ) -> [String: Any] {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: cue?.title ?? title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let cue {
      info[MPMediaItemPropertyArtist] = cue.artist
      info[MPMediaItemPropertyAlbumTitle] = title
    } else if let artist, !artist.isEmpty {
      info[MPMediaItemPropertyArtist] = artist
    }
    if let artwork {
      info[MPMediaItemPropertyArtwork] = artwork
    }
    if let duration {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    return info
  }

  /// Nonisolated, and it has to be. The system calls the handler on its own Now Playing queue
  /// whenever it wants the image at a new size, so a handler built on the main actor traps the
  /// moment it is asked. Nothing in here touches the main actor: the image is already decoded
  /// and the handler only hands back what it captured.
  nonisolated static func artwork(from data: Data) -> MPMediaItemArtwork? {
    #if os(macOS)
      guard let source = NSImage(data: data),
        let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
      else { return nil }
      let cropped = widescreen(cg)
      let image = NSImage(
        cgImage: cropped, size: NSSize(width: cropped.width, height: cropped.height))
    #else
      guard let source = UIImage(data: data), let cg = source.cgImage else { return nil }
      let image = UIImage(cgImage: widescreen(cg))
    #endif
    return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
  }

  nonisolated static func widescreen(_ image: CGImage) -> CGImage {
    let width = image.width
    let height = image.height
    let target = width * 9 / 16
    guard height > target + 2 else { return image }
    let rect = CGRect(x: 0, y: (height - target) / 2, width: width, height: target)
    return image.cropping(to: rect) ?? image
  }

  /// Nonisolated, so none of it runs on the main actor: activation is a slow call that the
  /// system warns will freeze a screen that makes it. From iOS 27 the framework offers a
  /// handler and never blocks at all; before that the blocking call is the only one there
  /// is, and running it here keeps it off the main thread just the same.
  private nonisolated static func startSession() async -> Bool {
    #if os(macOS)
      return true
    #else
      let session = AVAudioSession.sharedInstance()
      do {
        try session.setCategory(.playback, mode: .default)
      } catch {
        return false
      }
      if #available(iOS 27.0, tvOS 27.0, *) {
        return await withCheckedContinuation { continuation in
          session.activate(options: []) { activated, _ in
            continuation.resume(returning: activated)
          }
        }
      }
      do {
        try session.setActive(true)
        return true
      } catch {
        return false
      }
    #endif
  }

  private nonisolated static func endSession() async {
    #if !os(macOS)
      let session = AVAudioSession.sharedInstance()
      if #available(iOS 27.0, tvOS 27.0, *) {
        await withCheckedContinuation { continuation in
          session.deactivate(options: .notifyOthersOnDeactivation) { _, _ in
            continuation.resume()
          }
        }
      } else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
      }
    #endif
  }

  func play(set: SavedSet, baseURL: URL, token: String, startAt: TimeInterval = 0) {
    stop()
    currentSetId = set.id
    currentTitle = set.title
    currentArtist = set.creator
    cues = []
    currentArtwork = nil
    elapsed = startAt
    isSeeking = false
    pendingSeek = startAt > 0 ? startAt : nil
    duration = nil
    state = .loading
    let item = AVPlayerItem(
      asset: Self.asset(url: Self.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    playbackGeneration += 1
    let generation = playbackGeneration
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      let status = item.status
      let seconds = item.duration.seconds
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation else { return }
        self.itemStatusChanged(status: status, durationSeconds: seconds)
      }
    }
    rateObservation = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
      let rate = player.rate
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation else { return }
        self.rateChanged(rate: rate)
      }
    }
    stallObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
      let status = player.timeControlStatus
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation else { return }
        self.stallChanged(status: status)
      }
    }
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      let seconds = time.seconds
      MainActor.assumeIsolated {
        guard let self, self.playbackGeneration == generation else { return }
        guard !self.isSeeking, self.pendingSeek == nil else { return }
        let previousCue = self.currentCue?.position
        self.elapsed = seconds
        if self.currentCue?.position != previousCue {
          self.publishNowPlaying(isPlaying: self.state == .playing)
        }
      }
    }
    observeCompletion(of: item, generation: generation)
    observeInterruptions()
    let previous = sessionWork
    sessionWork = Task { [weak self] in
      await previous?.value
      let started = await Self.startSession()
      guard let self, self.playbackGeneration == generation else { return }
      guard started else {
        state = .failed("Audio could not start on this device.")
        return
      }
      self.player?.play()
      publishNowPlaying(isPlaying: true)
      fetchArtwork(for: set, generation: generation)
    }
  }

  private func fetchArtwork(for set: SavedSet, generation: Int) {
    artworkFetch?.cancel()
    guard let url = (set.artworkLargeUrl ?? set.artworkUrl).flatMap(URL.init(string:)) else {
      return
    }
    artworkFetch = Task { [weak self] in
      guard let (data, _) = try? await URLSession.shared.data(from: url) else { return }
      let artwork = Self.artwork(from: data)
      await MainActor.run {
        guard let self, self.playbackGeneration == generation, let artwork else { return }
        self.currentArtwork = artwork
        self.publishNowPlaying(isPlaying: self.state == .playing)
      }
    }
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
    guard let duration, duration.isFinite else {
      guard player != nil, state == .loading else { return }
      let target = max(seconds, 0)
      pendingSeek = target
      elapsed = target
      publishNowPlaying(isPlaying: false)
      return
    }
    let clamped = min(max(seconds, 0), duration)
    move(to: clamped)
    elapsed = clamped
    publishNowPlaying(isPlaying: state == .playing)
  }

  var canSkipCues: Bool { !cueStarts.isEmpty }

  func skipToNextCue() {
    guard let start = nextCue?.startSeconds else { return }
    seek(to: start)
  }

  func skipToPreviousCue() {
    let starts = cueStarts.filter { $0 <= elapsed }
    guard let current = starts.last else {
      seek(to: 0)
      return
    }
    if elapsed - current > 3 || starts.count < 2 {
      seek(to: current)
    } else {
      seek(to: starts[starts.count - 2])
    }
  }

  func setCues(_ cues: [Cue]) {
    guard self.cues != cues else { return }
    self.cues = cues
    publishNowPlaying(isPlaying: state == .playing)
  }

  func stop() {
    playbackGeneration += 1
    artworkFetch?.cancel()
    artworkFetch = nil
    currentArtwork = nil
    cues = []
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
    let previous = sessionWork
    sessionWork = Task {
      await previous?.value
      await Self.endSession()
    }
  }

  private func itemStatusChanged(status: AVPlayerItem.Status, durationSeconds: Double) {
    switch status {
    case .readyToPlay:
      duration = durationSeconds.isFinite ? durationSeconds : nil
      applyPendingSeek()
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

  private func applyPendingSeek() {
    guard let pendingSeek else { return }
    self.pendingSeek = nil
    guard player != nil else { return }
    let bounded = duration.map { min(pendingSeek, $0) } ?? pendingSeek
    move(to: bounded)
    elapsed = bounded
  }

  private func move(to seconds: TimeInterval) {
    guard let player else { return }
    isSeeking = true
    let generation = playbackGeneration
    player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation else { return }
        self.isSeeking = false
      }
    }
  }

  private func observeCompletion(of item: AVPlayerItem, generation: Int) {
    observers.append(
      NotificationCenter.default.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.playbackGeneration == generation,
            let finished = self.currentSetId
          else { return }
          self.onFinished?(finished)
        }
      }
    )
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
      artist: currentArtist,
      cue: currentCue,
      artwork: currentArtwork,
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
    let toggle = center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .noSuchContent }
      if self.state == .playing {
        self.pause()
      } else {
        self.resume()
      }
      return .success
    }
    center.togglePlayPauseCommand.isEnabled = true
    // The interval is set before the target, because the system reads it when the target arrives.
    center.skipBackwardCommand.preferredIntervals = [Self.skipBack as NSNumber]
    let back = center.skipBackwardCommand.addTarget { [weak self] event in
      self?.skip(by: -Self.interval(of: event, default: Self.skipBack))
      return .success
    }
    center.skipBackwardCommand.isEnabled = true
    center.skipForwardCommand.preferredIntervals = [Self.skipAhead as NSNumber]
    let ahead = center.skipForwardCommand.addTarget { [weak self] event in
      self?.skip(by: Self.interval(of: event, default: Self.skipAhead))
      return .success
    }
    center.skipForwardCommand.isEnabled = true
    commandTargets = [play, pause, toggle, back, ahead]
  }

  static let skipBack: TimeInterval = 15
  static let skipAhead: TimeInterval = 30

  func skip(by seconds: TimeInterval) {
    seek(to: elapsed + seconds)
  }

  private static func interval(of event: MPRemoteCommandEvent, default fallback: TimeInterval)
    -> TimeInterval
  {
    (event as? MPSkipIntervalCommandEvent)?.interval ?? fallback
  }

  private func observeInterruptions() {
    guard !isObservingInterruptions else { return }
    isObservingInterruptions = true
    #if !os(macOS)
      let center = NotificationCenter.default
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
