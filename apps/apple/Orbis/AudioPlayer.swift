import AVFoundation
import MediaPlayer

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// Plays one Set's retained audio, streamed from the service with the device token.
///
/// Everything here stays on the main actor: playback control is not CPU-bound, and
/// AVPlayer does its own threading. Observers that the system can call from any thread
/// capture plain values first and hop back here before touching state. The audio session
/// is the one exception, and it runs off the main actor: see `sessionWork`.
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
  /// Who made the Set, for the artist line the system draws under the title.
  private(set) var currentArtist: String?
  /// The Set's artwork, once it has arrived, for the lock screen, the Dynamic Island, and
  /// Control Center. Fetched after playback starts so a slow image never delays the sound.
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

  /// Called with the Set that has just played to its natural end, so the caller can finish its
  /// Listen and start whatever the Listening Queue holds next. Nothing is called when playback
  /// stops early: that Set keeps its position and its Listen.
  @ObservationIgnored var onFinished: ((String) -> Void)?

  /// Which observations are current: a callback carrying an older number is dropped.
  private var playbackGeneration = 0

  /// The audio session work still in flight. Bringing the session up or letting it go talks
  /// to the audio server and takes long enough to freeze a screen that waits for it, so it
  /// happens off the main actor. Each step waits for the one before it, because a stop that
  /// deactivates must never land after the play that follows it.
  private var sessionWork: Task<Void, Never>?

  /// The registrations this player made outside itself, held nonisolated so `deinit`, which
  /// cannot hop actors, takes back exactly its own handlers instead of clearing the shared
  /// command center. Ignored by observation: nothing reads them.
  @ObservationIgnored nonisolated(unsafe) private var commandTargets: [Any] = []
  @ObservationIgnored nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
  private var isObservingInterruptions = false

  init() {
    setupCommands()
  }

  deinit {
    // A nonisolated deinit cannot touch MainActor state, so everything owned here
    // is released through stop(), which every play() enters through first. What
    // remains is global, and only this player's own registrations are taken back.
    let center = MPRemoteCommandCenter.shared()
    for target in commandTargets {
      center.playCommand.removeTarget(target)
      center.pauseCommand.removeTarget(target)
    }
    center.playCommand.isEnabled = false
    center.pauseCommand.isEnabled = false
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

  /// The Set's own audio file under the service address.
  static func fileURL(setID: String, baseURL: URL) -> URL {
    baseURL.appending(path: "sets/\(setID)/audio")
  }

  /// The Now Playing dictionary for a moment in time. Elapsed time and rate are set
  /// at play, pause, seek, and track change only: the system extrapolates between
  /// them, and a timer would only add jitter.
  static func nowPlayingInfo(
    title: String,
    artist: String? = nil,
    artwork: MPMediaItemArtwork? = nil,
    duration: TimeInterval?,
    elapsed: TimeInterval,
    isPlaying: Bool
  ) -> [String: Any] {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
      // A Set is one long recording, which the system otherwise treats as a song and
      // offers to skip past.
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let artist, !artist.isEmpty {
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

  /// The image the provider offered, as the system wants it: a handler that returns the same
  /// image at any size, since the provider gives one size and the system scales it.
  ///
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

  /// The middle 16:9 band of an image that is taller than 16:9; an image that is already as
  /// wide, or wider, is returned as it is.
  nonisolated static func widescreen(_ image: CGImage) -> CGImage {
    let width = image.width
    let height = image.height
    let target = width * 9 / 16
    // A few pixels of tolerance, so a 1280×721 render is not cropped for nothing.
    guard height > target + 2 else { return image }
    let rect = CGRect(x: 0, y: (height - target) / 2, width: width, height: target)
    return image.cropping(to: rect) ?? image
  }

  /// Brings the audio session up for playback and answers whether it came up.
  ///
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
      if #available(iOS 27.0, *) {
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

  /// Lets the audio session go, off the main actor for the same reason, and tells whoever this
  /// playback interrupted that it may resume. Waits for the answer, so the next activation
  /// queued behind it cannot be undone by this deactivation landing late.
  private nonisolated static func endSession() async {
    #if !os(macOS)
      let session = AVAudioSession.sharedInstance()
      if #available(iOS 27.0, *) {
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
    currentArtwork = nil
    elapsed = startAt
    pendingSeek = startAt > 0 ? startAt : nil
    duration = nil
    state = .loading
    // The asset is the Set's own audio file, not the service root: loading the
    // root answers 404 and the player fails without ever asking for audio.
    let item = AVPlayerItem(
      asset: Self.asset(url: Self.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    playbackGeneration += 1
    let generation = playbackGeneration
    // KVO can call back on any thread, so each handler captures plain values and
    // hops here before touching state. The generation check drops a callback that a
    // stopped or replaced player queued before this one took over.
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
      // Registered on the main queue, so this closure is already on the main actor; assuming it
      // avoids a task on every tick.
      MainActor.assumeIsolated {
        guard let self, self.playbackGeneration == generation else { return }
        self.elapsed = seconds
      }
    }
    observeCompletion(of: item, generation: generation)
    observeInterruptions()
    // The screen already reads as loading, so the sound can wait for the session rather than
    // the screen waiting for both. A generation that has moved on drops what comes back.
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

  /// The largest image the provider offered, fetched off the play path. A stale fetch, one that
  /// lands after another Set took over, is dropped by the generation it was made under.
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
    guard let duration, duration.isFinite else { return }
    let clamped = min(max(seconds, 0), duration)
    player?.seek(to: CMTime(seconds: clamped, preferredTimescale: 600))
    elapsed = clamped
    publishNowPlaying(isPlaying: state == .playing)
  }

  func stop() {
    // Anything the player in hand still has queued belongs to a playback that is over.
    playbackGeneration += 1
    artworkFetch?.cancel()
    artworkFetch = nil
    currentArtwork = nil
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

  /// Where a resumed Set starts. A position past the end of the audio would leave the item
  /// finished the moment it began, so the seek is bounded by the length the item reports.
  private func applyPendingSeek() {
    guard let pendingSeek else { return }
    self.pendingSeek = nil
    guard let player else { return }
    let bounded = duration.map { min(pendingSeek, $0) } ?? pendingSeek
    player.seek(to: CMTime(seconds: bounded, preferredTimescale: 600))
    elapsed = bounded
  }

  /// The end of the audio, which is the one way a Listen finishes. Registered per play, because
  /// the notification names the item that ended.
  private func observeCompletion(of item: AVPlayerItem, generation: Int) {
    observers.append(
      NotificationCenter.default.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification,
        object: item,
        queue: .main
      ) { [weak self] _ in
        // Registered on the main queue, so this block is already on the main actor.
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
