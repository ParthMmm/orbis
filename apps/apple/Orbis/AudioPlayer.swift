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
/// hop back here and read the player's current values before touching state. The audio
/// session and the artwork decode are the exceptions, and run off the main actor: see
/// `sessionWork` and `artwork(from:)`.
@MainActor
@Observable
final class AudioPlayer {
  /// Where playback stands, and what the person last asked for. One value holds both, so a
  /// press and a late callback can never disagree about whether sound is wanted: `.loading`
  /// and `.playing` mean the person asked to hear the Set, `.paused` means they asked for
  /// quiet, and `.interrupted` means the system took the sound away while they wanted it.
  /// Sound starts only through `startPlayback()`, and only while the state still asks for it
  /// once the audio session is up.
  enum PlaybackState: Equatable {
    case idle
    /// Sound is wanted and has not started: the session is coming up or the stream is filling.
    case loading
    case playing
    case paused
    /// The sound stopped while the Set was wanted, and the person did not stop it: a call, an
    /// alarm, or another app took the session, or the player stopped on its own. Only `pause()`
    /// records the person's quiet as `.paused`, so the end of an interruption resumes this
    /// state and never a Set the person paused. The player's own rate drop can arrive before
    /// the interruption notice does, which is why it lands here and not in `.paused`.
    case interrupted
    case failed(String)
  }

  private(set) var state = PlaybackState.idle
  private(set) var currentSetId: String?
  private(set) var currentTitle = ""
  /// Who made the Set, for the artist line the system draws under the title.
  private(set) var currentArtist: String?
  private var cues: [Cue] = []
  /// Where each Cue starts, for the marks along the seek bar.
  var cueStarts: [TimeInterval] { cues.compactMap(\.startSeconds) }
  var currentCue: Cue? {
    cues.last { cue in cue.startSeconds.map { $0 <= elapsed } ?? false }
  }
  /// The Cue the mix moves into next, once it has a start time.
  var nextCue: Cue? {
    cues.first { cue in cue.startSeconds.map { $0 > elapsed } ?? false }
  }
  /// The Set's artwork, once it has arrived, for the lock screen, the Dynamic Island, and
  /// Control Center. Fetched after playback starts so a slow image never delays the sound.
  private var currentArtwork: MPMediaItemArtwork?
  private var artworkFetch: Task<Void, Never>?
  private(set) var elapsed: TimeInterval = 0
  private(set) var duration: TimeInterval?

  private(set) var player: AVPlayer?
  private var timeObserver: Any?
  private var statusObservation: NSKeyValueObservation?
  private var rateObservation: NSKeyValueObservation?
  private var stallObservation: NSKeyValueObservation?

  /// Where a resumed Set should start once its item is ready. AVPlayer refuses a seek before the
  /// item knows its own timeline, so the position waits here until it does.
  private var pendingSeek: TimeInterval?
  private var isSeeking = false

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
  private(set) var sessionWork: Task<Void, Never>?

  /// How the audio session comes up and goes away. The system's in the app; a test passes its own
  /// to hold activation open and press buttons while it is pending.
  struct Session: Sendable {
    var start: @Sendable () async -> Bool
    var end: @Sendable () async -> Void

    static let system = Session(
      start: { await AudioPlayer.startSession() },
      end: { await AudioPlayer.endSession() }
    )
  }

  private let session: Session

  /// The registrations this player made outside itself, held nonisolated so `deinit`, which
  /// cannot hop actors, takes back exactly its own handlers instead of clearing the shared
  /// command center. Ignored by observation: nothing reads them.
  ///
  /// `nonisolated(unsafe)` is sound only while this holds: every read and write outside
  /// `deinit` happens on the main actor (in `init`, `setupCommands`, `stop`, and the observe
  /// methods), and `deinit` runs when no other reference is left, so it has the arrays to
  /// itself. A write from anywhere else would be a data race the compiler no longer checks.
  @ObservationIgnored nonisolated(unsafe) private var commandTargets: [Any] = []
  @ObservationIgnored nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
  private var isObservingInterruptions = false

  init(session: Session = .system) {
    self.session = session
    setupCommands()
  }

  deinit {
    // A nonisolated deinit cannot touch MainActor state, so everything owned here
    // is released through stop(), which every play() enters through first. What
    // remains is global, and only this player's own registrations are taken back.
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
      // A Set is one long recording, which the system otherwise treats as a song and
      // offers to skip past.
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

  /// The image the provider offered, as the system wants it: a handler that returns the same
  /// image at any size, since the provider gives one size and the system scales it.
  ///
  /// `@concurrent`, so the decode and crop run off the main actor rather than on the thread
  /// that draws the screen. Nonisolated for a second reason too: the system calls the handler
  /// on its own Now Playing queue whenever it wants the image at a new size, so a handler built
  /// on the main actor traps the moment it is asked. Nothing in here touches the main actor:
  /// the image is already decoded and the handler only hands back what it captured.
  @concurrent nonisolated static func artwork(from data: Data) async -> sending MPMediaItemArtwork? {
    #if os(macOS)
      guard let source = NSImage(data: data),
        let cg = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
      else { return nil }
      let cropped = widescreen(cg)
      let image = NSImage(
        cgImage: cropped, size: NSSize(width: cropped.width, height: cropped.height))
    #else
      guard let source = UIImage(data: data), let cg = source.cgImage else { return nil }
      // Decoded here rather than on first draw, so the pixels are ready before the system asks
      // and the uncropped original is not kept alive behind the crop.
      let cropped = UIImage(cgImage: widescreen(cg))
      let image = cropped.preparingForDisplay() ?? cropped
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
  /// `@concurrent`, so none of it runs on the main actor whatever the caller's isolation:
  /// activation is a slow call that the system warns will freeze a screen that makes it. From
  /// iOS 27 the framework offers a handler and never blocks at all; before that the blocking
  /// call is the only one there is, and running it here keeps it off the main thread just the
  /// same.
  @concurrent fileprivate nonisolated static func startSession() async -> Bool {
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

  /// Lets the audio session go, off the main actor for the same reason, and tells whoever this
  /// playback interrupted that it may resume. Waits for the answer, so the next activation
  /// queued behind it cannot be undone by this deactivation landing late.
  @concurrent fileprivate nonisolated static func endSession() async {
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
    // The asset is the Set's own audio file, not the service root: loading the
    // root answers 404 and the player fails without ever asking for audio.
    let item = AVPlayerItem(
      asset: Self.asset(url: Self.fileURL(setID: set.id, baseURL: baseURL), token: token)
    )
    let player = AVPlayer(playerItem: item)
    self.player = player
    playbackGeneration += 1
    let generation = playbackGeneration
    // KVO can call back on any thread, so each handler only hops here. Each hop is its own
    // task, and two of them can land in either order, so the hop reads the player's current
    // values rather than the ones that fired it: a late hop then repeats the latest state
    // instead of undoing it. The generation check drops a callback that a stopped or replaced
    // player queued before this one took over.
    statusObservation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation,
          let item = self.player?.currentItem
        else { return }
        self.itemStatusChanged(status: item.status, durationSeconds: item.duration.seconds)
      }
    }
    rateObservation = player.observe(\.rate, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, let player = self.player
        else { return }
        self.rateChanged(rate: player.rate)
      }
    }
    stallObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in
        guard let self, self.playbackGeneration == generation, let player = self.player
        else { return }
        self.stallChanged(status: player.timeControlStatus)
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
    // The screen already reads as loading, so the sound can wait for the session rather than
    // the screen waiting for both.
    startPlayback()
    fetchArtwork(for: set, generation: generation)
  }

  /// Starts the sound once the audio session is up. Every start goes through here (the first
  /// play, a resume, the lock screen's Play, the end of an interruption), so none plays without
  /// an active session. It queues behind the session work already in flight and asks for the
  /// session again each time: asking costs little when the session is up, and is what brings it
  /// back after a failure or an interruption took it down.
  ///
  /// What the person asks for while it waits wins. A pause in the meantime leaves the state at
  /// `.paused`, and the player stays quiet when the session answers. A generation that has
  /// moved on drops what comes back.
  ///
  /// Only the latest start acts. One queued behind it answers for the newer press, so an earlier
  /// start that fails cannot mark the Set failed under it, and one that succeeds does not play
  /// ahead of it.
  private func startPlayback() {
    let generation = playbackGeneration
    latestStart += 1
    let start = latestStart
    let previous = sessionWork
    let startSession = session.start
    sessionWork = Task { [weak self] in
      await previous?.value
      let started = await startSession()
      guard let self, self.playbackGeneration == generation, self.latestStart == start,
        self.wantsSound
      else { return }
      guard started else {
        self.player?.pause()
        self.state = .failed("Audio could not start on this device.")
        self.publishNowPlaying(isPlaying: false)
        return
      }
      self.player?.play()
      self.publishNowPlaying(isPlaying: true)
    }
  }

  /// Which `startPlayback()` call is the newest; an older one that finishes first does nothing.
  @ObservationIgnored private var latestStart = 0

  /// True while the person has asked to hear the Set, whether or not the sound has started.
  private var wantsSound: Bool {
    state == .loading || state == .playing
  }

  /// The largest image the provider offered, fetched off the play path. A stale fetch, one that
  /// lands after another Set took over, is dropped by the generation it was made under.
  private func fetchArtwork(for set: SavedSet, generation: Int) {
    artworkFetch?.cancel()
    guard let url = (set.artworkLargeUrl ?? set.artworkUrl).flatMap(URL.init(string:)) else {
      return
    }
    artworkFetch = Task { [weak self] in
      guard
        let (data, response) = try? await URLSession.shared.data(
          for: URLRequest(url: url, timeoutInterval: 15)),
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
      else { return }
      let artwork = await Self.artwork(from: data)
      guard let self, self.playbackGeneration == generation, let artwork else { return }
      self.currentArtwork = artwork
      self.publishNowPlaying(isPlaying: self.state == .playing)
    }
  }

  /// Quiets the Set and records that the person asked for quiet, so a session start still in
  /// flight does not play it when it lands.
  func pause() {
    player?.pause()
    if wantsSound || state == .interrupted {
      state = .paused
    }
    publishNowPlaying(isPlaying: false)
  }

  /// Plays the Set in the player again. Waits for the audio session like any start, so a resume
  /// before the session is up, or after a failure or interruption took it down, still has one.
  /// An item that failed to load has nothing to resume; the caller starts the Set again.
  func resume() {
    guard let item = player?.currentItem, item.status != .failed else { return }
    switch state {
    case .paused, .interrupted, .failed:
      // Now Playing turns to playing when the sound does, in `startPlayback()`.
      state = .loading
      startPlayback()
    case .idle, .loading, .playing:
      return
    }
  }

  /// What a single play/pause control does: pauses while sound is wanted, including while it
  /// is still loading, and resumes otherwise.
  func togglePlayPause() {
    if wantsSound {
      pause()
    } else {
      resume()
    }
  }

  func seek(to seconds: TimeInterval) {
    guard let duration, duration.isFinite else {
      guard player != nil, wantsSound || state == .paused || state == .interrupted else {
        return
      }
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

  /// Whether the Set's Tracklist has start times to step between.
  var canSkipCues: Bool { !cueStarts.isEmpty }

  /// Jumps to the start of the next Cue. Past the last one there is nowhere to go.
  func skipToNextCue() {
    guard let start = nextCue?.startSeconds else { return }
    seek(to: start)
  }

  /// Jumps back the way a music player's back button does: to the start of this Cue, or to the
  /// previous one when this one has barely begun.
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
    // Anything the player in hand still has queued belongs to a playback that is over.
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
    let endSession = session.end
    sessionWork = Task {
      await previous?.value
      await endSession()
    }
  }

  private func itemStatusChanged(status: AVPlayerItem.Status, durationSeconds: Double) {
    switch status {
    case .readyToPlay:
      duration = durationSeconds.isFinite ? durationSeconds : nil
      applyPendingSeek()
      publishNowPlaying(isPlaying: wantsSound)
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

  /// A rate the player reached by itself. A drop to zero the person did not ask for is the
  /// system's, so it reads as `.interrupted`: `pause()` has already moved a pause of theirs to
  /// `.paused` before the player reports it.
  ///
  /// Internal rather than private so a test can apply a change the system made, which it cannot
  /// make an unloaded player report.
  func rateChanged(rate: Float) {
    switch state {
    case .playing where rate == 0:
      state = .interrupted
      publishNowPlaying(isPlaying: false)
    case .paused where rate > 0, .interrupted where rate > 0:
      state = .playing
      publishNowPlaying(isPlaying: true)
    default:
      break
    }
  }

  func stallChanged(status: AVPlayer.TimeControlStatus) {
    switch status {
    case .playing:
      if state == .loading {
        state = .playing
      }
    case .paused:
      // As with the rate: the person's own pause is already `.paused` by the time this lands.
      if state == .playing {
        state = .interrupted
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
      self?.resume()
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
      self.togglePlayPause()
      return .success
    }
    center.togglePlayPauseCommand.isEnabled = true
    // The same skips as the transport beside Play, so the Lock Screen and the car offer them too.
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

  /// Moves the playhead by a number of seconds, back when negative.
  func skip(by seconds: TimeInterval) {
    seek(to: elapsed + seconds)
  }

  /// Siri can ask for a skip of its own length, so the event's interval wins over the button's.
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
      // Registered on the main queue, so each block already runs on the main actor and
      // assumes it, like the completion observer, rather than queueing a task that could land
      // after a later press. Notification is not Sendable, so plain values are read first.
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
          MainActor.assumeIsolated {
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
          guard reason == .oldDeviceUnavailable else { return }
          MainActor.assumeIsolated {
            self?.pause()
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
        // Only a Set the person wanted is marked interrupted; a paused one stays paused.
        guard wantsSound else { return }
        player?.pause()
        state = .interrupted
        publishNowPlaying(isPlaying: false)
      case .ended:
        guard state == .interrupted else { return }
        // The interruption took the session down; `resume()` brings it back before playing.
        // Without the system's leave to resume, the Set waits for the person's Play.
        if shouldResume {
          resume()
        } else {
          state = .paused
        }
      @unknown default:
        break
      }
    }
  #endif
}
