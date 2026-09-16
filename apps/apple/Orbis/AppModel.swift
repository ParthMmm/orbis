import Foundation
import Observation
import OrbisDesign

/// What a screen is showing. Keeps loading, failure, and the two distinct empty cases
/// explicit instead of inferring them from a list being empty.
enum Loadable<Value: Equatable>: Equatable {
  case idle
  case loading
  case loaded(Value)
  case failed(OrbisFailure)

  /// Whether the answer has arrived, in either form. A failure is settled: it has something to
  /// say, and a splash covering it would only delay the sentence and its retry.
  var isSettled: Bool {
    switch self {
    case .idle, .loading: false
    case .loaded, .failed: true
    }
  }
}

@MainActor
@Observable
final class AppModel {
  private(set) var client: OrbisClient?

  var connectionAddress: String
  var connectionToken = ""
  var connectionFailure: OrbisFailure?
  var isTestingConnection = false

  var library: Loadable<[SavedSet]> = .idle {
    didSet { refreshDerivedState() }
  }
  var playlists: Loadable<[Playlist]> = .idle
  /// The one Listening Queue. It is where the active Set and the Playback Position live, so the
  /// mini player and the Set page read playback state from it rather than tracking their own.
  var queue: Loadable<ListeningQueue> = .idle
  /// What the last queue action did, said where the action was taken.
  var queueNotice: String?
  /// The playlist the Library is showing. Nil is everything the library holds.
  var selectedPlaylistId: String?
  var searchQuery = ""
  var search: Loadable<[SavedSet]> = .idle

  /// The query the loaded search results answer. Held beside the results rather than read
  /// back from the field, so the heading never names results with a query that was typed
  /// but not submitted.
  private(set) var searchResultsFor: String?

  /// The tag the Library is filtered by. One tag at a time, because the row marks the one
  /// tag a view is filtered by and a Set carries several.
  var activeTag: String? {
    didSet { refreshDerivedState() }
  }

  /// Every tag in the loaded library, in a stable order, so the filter row does not reshuffle
  /// between loads. Derived from the Sets rather than fetched, because the Library already
  /// holds all of them. Held rather than derived on demand, because every list body reads
  /// it on every render.
  private(set) var availableTags: [String] = []

  /// The Sets the filter admits. Unfiltered, it is the library itself. Held for the same
  /// reason as the tags: the body of every list reads it on every pass.
  private(set) var visibleSets: Loadable<[SavedSet]> = .idle

  /// Recomputes everything derived from the library and the filter. Every change to either
  /// lands here, so the cached views of the library cannot drift from it.
  private func refreshDerivedState() {
    guard case .loaded(let sets) = library else {
      availableTags = []
      visibleSets = library
      return
    }
    availableTags = Set(sets.flatMap(\.tags)).sorted()
    if let activeTag {
      visibleSets = .loaded(sets.filter { $0.tags.contains(activeTag) })
    } else {
      visibleSets = .loaded(sets)
    }
  }

  /// True when this device already holds a token, which makes the token field optional: a
  /// wrong address is corrected without pairing again. Held as state rather than asked of
  /// the keychain on every render, because a view body must not block on credential
  /// storage; the model refreshes it whenever the pairing changes.
  private(set) var hasStoredToken: Bool

  /// How many times a cancelled load has been restarted without a success in between.
  private var reloadsAfterCancellation = 0

  /// Which request each stream is on. Every start moves its stream's generation on, so a
  /// response that arrives after a newer one began cannot publish over it.
  private var libraryGeneration = 0
  private var searchGeneration = 0
  private var playlistGeneration = 0
  private var queueGeneration = 0
  private var connectionGeneration = 0

  /// What the person has pasted but not filed yet, and what the last filing said.
  var linkToFile = ""
  var isFiling = false
  /// What the clipboard had to say when it held nothing Orbis takes. Said beside the button rather
  /// than written into the field, so a paste that cannot be filed changes nothing.
  var pasteNotice: String?
  var fileConfirmation: String?
  /// What the last filing refused, kept as the error so the field can tell an address Orbis
  /// does not know from one the library already holds.
  var fileFailure: OrbisError?

  /// The Set filed moments ago, whose title and Tags the service read from the link. This is
  /// the person's chance to overrule that reading, and it closes without a change.
  struct Reveal: Equatable {
    let set: SavedSet
    var title: String
    var tags: [String]

    /// The title to send, or nil when there is nothing to send: an empty field means "leave the
    /// title that came with the Set", which is what a failed enrichment leaves behind, and an
    /// unchanged one is not worth a request.
    var renamedTitle: String? {
      let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)
      guard !trimmed.isEmpty, String(trimmed) != set.title else { return nil }
      return String(trimmed)
    }

    /// True while the title is still whatever arrived with the Set, including the placeholder
    /// a failed enrichment leaves, so a later retry may replace it.
    var titleUntouched: Bool {
      title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title == set.title
    }

    var hasChanges: Bool { renamedTitle != nil || tags != set.tags }
  }

  var reveal: Reveal?
  var isSavingReveal = false
  var revealFailure: OrbisFailure?

  /// The latest download progress the service reported, by Set. Terminal states reload
  /// the library instead, so this only ever holds a download that is still running.
  var audioStates: [String: AudioState] = [:]

  /// The watches on downloads that are still running, by Set. Held by the model rather than by
  /// the page that asked for the download, because a person who starts one and leaves still needs
  /// its result in the Library.
  private var downloadWatchers: [String: Task<Void, Never>] = [:]

  /// How many times one download is polled before a watch gives up: ten minutes at one second a
  /// poll. Bounded, so a service that never reaches a terminal state cannot leave a task running
  /// for the life of the app.
  private static let downloadWatchLimit = 600

  var destination: Destination = .home

  /// True while the connection screen is open over a configured library. An address that stops
  /// working used to leave Forget this device as the only way back to it, which throws away a
  /// working token to fix a typo.
  var isEditingConnection = false

  /// Where this model keeps the pairing. Held per model, so a test hands a model a store of its
  /// own instead of writing the device's real one.
  private let settings: any ClientSettingsStore

  /// Follows the player and reports where playback has reached. One of these exists at a time,
  /// because one Set plays at a time.
  private var positionReporter: Task<Void, Never>?

  init(settings: any ClientSettingsStore = ClientSettings.forCurrentProcess()) {
    self.settings = settings
    // A journey lane starts from a clean install so it exercises the connection screen.
    Self.resetSettings(ifRequestedBy: ProcessInfo.processInfo.arguments, in: settings)
    // A lane that checks a filtered Library opens already filtered, which is how the no-matches
    // state is reached without a tag that has no Sets.
    let arguments = ProcessInfo.processInfo.arguments
    if let flag = arguments.firstIndex(of: "-orbisStartTagFiltered"),
      arguments.indices.contains(flag + 1)
    {
      activeTag = arguments[flag + 1]
    }
    connectionAddress = settings.serviceAddress ?? ""
    client = settings.configuredClient()
    hasStoredToken = settings.deviceToken?.isEmpty == false
    refreshDerivedState()
    wirePlayerToQueue()
  }

  /// A model already paired with a service. The launch screen and the settings file are the real
  /// path; this one exists so tests and previews can drive a change without either.
  init(client: OrbisClient, settings: any ClientSettingsStore) {
    self.settings = settings
    self.client = client
    connectionAddress = client.address.absoluteString
    hasStoredToken = settings.deviceToken?.isEmpty == false
    refreshDerivedState()
    wirePlayerToQueue()
  }

  /// Clears the store the model was given when the launch arguments ask for a fresh install.
  /// Settings-only, so the reset can be proven against a supplied store rather than by
  /// starting an app that is already paired with a device.
  static func resetSettings(ifRequestedBy arguments: [String], in settings: any ClientSettingsStore) {
    guard arguments.contains("-orbisResetSettings") else { return }
    settings.serviceAddress = nil
    settings.store(deviceToken: nil)
  }

  var isConfigured: Bool { client != nil }

  var visibleCount: Int {
    guard case .loaded(let sets) = visibleSets else { return 0 }
    return sets.count
  }

  var totalCount: Int {
    guard case .loaded(let sets) = library else { return 0 }
    return sets.count
  }

  var playlistItems: [Playlist] {
    guard case .loaded(let items) = playlists else { return [] }
    return items
  }

  func setTagFilter(_ tag: String?) {
    activeTag = tag
  }

  /// Tests the connection before storing anything, so a wrong address or token never
  /// replaces a working configuration.
  func connect() async {
    connectionGeneration += 1
    let generation = connectionGeneration
    connectionFailure = nil
    isTestingConnection = true
    // A superseded test leaves the flag alone, because a newer test still owns it.
    defer {
      if generation == connectionGeneration {
        isTestingConnection = false
      }
    }
    // An empty field means keep the token this device already holds, which is what correcting
    // an address needs. A typed token replaces it.
    let typed = connectionToken.trimmingCharacters(in: .whitespacesAndNewlines)
    let token = typed.isEmpty ? (settings.deviceToken ?? "") : typed
    guard !token.isEmpty else {
      connectionFailure = OrbisError.notPaired.failure(at: URL(string: connectionAddress))
      return
    }
    do {
      let url = try OrbisClient.address(from: connectionAddress)
      // The candidate keeps the session the model already uses, so tests inject one session
      // and it covers the connection test too.
      let candidate = OrbisClient(
        address: url, token: token, session: client?.session ?? .shared)
      _ = try await candidate.health()
      // The screen that opened this test may be gone, and a newer test may have started;
      // neither may replace what this device trusts.
      guard generation == connectionGeneration, !Task.isCancelled else { return }
      // The token is stored before anything commits, so a device that would not hold it
      // changes nothing and says so where the address was typed.
      guard settings.store(deviceToken: token) else {
        connectionFailure = OrbisError.storageRefused.failure(at: url)
        return
      }
      settings.serviceAddress = url.absoluteString
      client = candidate
      hasStoredToken = true
      isEditingConnection = false
      // A different service is a different set of downloads: nothing here asks the new service
      // about a Set it has never heard of.
      stopDownloadWatches()
      audioStates.removeAll()
      await loadLibrary()
      // The sidebar reads playlists separately from the library, so pairing fills both.
      await loadPlaylists()
      // Playback is shared state: another device may be the one that is playing.
      await loadQueue()
    } catch let error as OrbisError {
      guard generation == connectionGeneration else { return }
      connectionFailure = error.failure(at: URL(string: connectionAddress))
    } catch {
      guard generation == connectionGeneration else { return }
      connectionFailure = OrbisError.unreachable.failure(at: URL(string: connectionAddress))
    }
  }

  /// Opens the connection screen with the address in place and the token left out. Leaving the
  /// token field empty keeps the token this device already has, so a wrong address can be
  /// corrected without pairing again.
  func editConnection() {
    // The screen reopening is itself a change of mind: a connection test that was already
    // out belongs to the screen that closed, not to this one.
    connectionGeneration += 1
    connectionAddress = settings.serviceAddress ?? connectionAddress
    connectionToken = ""
    connectionFailure = nil
    isEditingConnection = true
  }

  func closeConnectionEditor() {
    // Closing dismisses a connection test that is still out, so its answer cannot commit
    // into a screen the person has already left.
    connectionGeneration += 1
    connectionFailure = nil
    isEditingConnection = false
  }

  func forget() {
    // Everything the old service could still answer becomes unpublishable the moment this
    // runs, so no pending response repopulates a pairing this device no longer holds.
    connectionGeneration += 1
    libraryGeneration += 1
    searchGeneration += 1
    playlistGeneration += 1
    queueGeneration += 1
    // Audio still playing comes from a service this device no longer holds a token for, and a
    // download the old service is running is the same: nothing here may keep asking about it.
    audioPlayer.stop()
    stopDownloadWatches()
    stopReportingPosition()
    audioStates.removeAll()
    settings.serviceAddress = nil
    settings.store(deviceToken: nil)
    client = nil
    connectionToken = ""
    connectionAddress = ""
    hasStoredToken = false
    library = .idle
    search = .idle
    searchResultsFor = nil
    playlists = .idle
    queue = .idle
    queueNotice = nil
    selectedPlaylistId = nil
    openedPlaylistId = nil
    playlistMembers = .idle
    playlistFailure = nil
    activeTag = nil
    openedSetId = nil
    reveal = nil
    revealFailure = nil
    isEditingConnection = false
  }

  func loadLibrary() async {
    guard let client else { return }
    libraryGeneration += 1
    let generation = libraryGeneration
    library = .loading
    do {
      let sets = try await client.library(playlistId: selectedPlaylistId)
      guard generation == libraryGeneration, !Task.isCancelled else { return }
      library = .loaded(sets)
      reloadsAfterCancellation = 0
      // A download the service is still running is watched from here, which is what resumes a
      // watch after a relaunch and catches one another device started.
      for set in sets where isDownloading(set.id) {
        watchDownload(set.id)
      }
    } catch OrbisError.cancelled {
      guard generation == libraryGeneration, !Task.isCancelled else { return }
      // The screen that asked for this went away, which is not a failure. The retry runs
      // in a task that is not a child of this one, because a cancelled task cancels
      // everything it waits on, and it is bounded so a screen that keeps vanishing cannot
      // spin forever.
      library = .idle
      if reloadsAfterCancellation < 2 {
        reloadsAfterCancellation += 1
        Task { [weak self] in await self?.loadLibrary() }
      }
    } catch let error as OrbisError {
      guard generation == libraryGeneration else { return }
      library = .failed(error.failure(at: client.address))
    } catch {
      guard generation == libraryGeneration else { return }
      library = .failed(OrbisError.unreachable.failure(at: client.address))
    }
  }

  /// Files the pasted link and puts the saved Set at the top of the list it belongs in.
  /// The list is not reloaded through a spinner, so filing does not blank the screen.
  func fileLink() async {
    guard let client else { return }
    let link = linkToFile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !link.isEmpty else { return }
    isFiling = true
    fileFailure = nil
    fileConfirmation = nil
    defer { isFiling = false }
    do {
      let saved = try await client.save(url: link)
      linkToFile = ""
      // A failed enrichment leaves a placeholder title, so the field starts empty rather
      // than inviting the placeholder to be kept.
      reveal = Reveal(
        set: saved,
        title: saved.metadataState == "failed" ? "" : saved.title,
        tags: saved.tags
      )
      if case .loaded(let sets) = library {
        // Filing moves the stream on, so a load that was already out cannot arrive later
        // and erase the Set that was just filed.
        libraryGeneration += 1
        // While the Library is showing one playlist, a filed Set joins the list only when
        // it belongs there; anything else would say the view holds what it does not.
        let belongs = selectedPlaylistId.map(saved.playlistIds.contains) ?? true
        library = .loaded(
          belongs ? [saved] + sets.filter { $0.id != saved.id } : sets.filter { $0.id != saved.id })
      } else {
        await loadLibrary()
      }
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      fileFailure = error
    } catch {
      fileFailure = .unreachable
    }
  }

  /// Files the link the clipboard holds, once it is confirmed as one Orbis takes.
  ///
  /// The confirmation happens here, before the round trip, so pasting something else costs no
  /// request and leaves the field as it was.
  func pasteAndFile(_ text: String) async {
    pasteNotice = nil
    guard let url = LinkField.address(of: text), SetSource.named(by: url) != nil else {
      pasteNotice = "The clipboard holds no YouTube or SoundCloud link."
      return
    }
    linkToFile = text.trimmingCharacters(in: .whitespacesAndNewlines)
    await fileLink()
  }

  /// Names the Set that was just filed. Only what changed goes to the service, and each change
  /// lands in the list as it is accepted, so a failure halfway keeps the part that worked.
  func saveReveal() async {
    guard let open = reveal else { return }
    guard open.hasChanges else {
      closeReveal()
      return
    }
    guard let client else { return }
    isSavingReveal = true
    revealFailure = nil
    defer { isSavingReveal = false }
    do {
      var updated = open.set
      if let title = open.renamedTitle {
        updated = try await client.updateTitle(open.set.id, title: title)
        // The reveal may have been closed while the request was out; a late response
        // never reopens a screen the person left.
        guard reveal?.set.id == open.set.id, !Task.isCancelled else { return }
        await publish(updated)
      }
      if open.tags != open.set.tags {
        updated = try await client.updateTags(open.set.id, tags: open.tags)
        guard reveal?.set.id == open.set.id, !Task.isCancelled else { return }
        await publish(updated)
      }
      closeReveal(with: updated)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      revealFailure = error.failure(at: client.address)
    } catch {
      revealFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Asks the service again to name a Set, which is what a link it could not read leaves
  /// behind. A title the person typed over the guess stays theirs.
  func retryMetadata() async {
    // A retry already out owns the answer, and a second one would stack two responses over
    // one draft.
    guard !isSavingReveal else { return }
    guard let client, let open = reveal else { return }
    isSavingReveal = true
    revealFailure = nil
    defer { isSavingReveal = false }
    do {
      let updated = try await client.retryMetadata(open.set.id)
      // The person can keep typing while the retry is out, so the response merges into the
      // draft held now rather than the snapshot the request started from. A reveal that was
      // closed, or replaced by another Set, still discards the late answer.
      guard let current = reveal, current.set.id == open.set.id, !Task.isCancelled else { return }
      await publish(updated)
      reveal = Reveal(
        set: updated, title: current.titleUntouched ? updated.title : current.title,
        tags: current.tags)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      revealFailure = error.failure(at: client.address)
    } catch {
      revealFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Asks the service to fetch this Set's audio and keep it. The answer carries the
  /// new download state straight into the list, the way a rename lands.
  func downloadAudio(_ id: String) async {
    guard let client else { return }
    do {
      await publish(try await client.requestAudioDownload(id))
      watchDownload(id)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Stops a running download and drops its partial file.
  func cancelAudioDownload(_ id: String) async {
    guard let client else { return }
    do {
      await publish(try await client.cancelAudioDownload(id))
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Reads the service's download progress into the running map. A terminal state
  /// reloads the library so the Set's own state is what the service holds; a poll
  /// that fails says nothing, because the next poll or the next visit retries it.
  func refreshAudioState(_ id: String) async {
    guard let client else { return }
    guard let state = try? await client.audioState(id) else { return }
    audioStates[id] = state
    if state.state == "ready" || state.state == "failed" {
      audioStates[id] = nil
      await loadLibrary()
    }
  }

  /// True while the service is still working on this Set's audio.
  private func isDownloading(_ id: String) -> Bool {
    ["queued", "downloading"].contains(savedSet(id)?.downloadState ?? "none")
  }

  /// Watches a Set's download until the service reports a state that is no longer running. One
  /// watch per Set, ended by the terminal state, by cancellation, or at the attempt limit.
  private func watchDownload(_ id: String) {
    guard downloadWatchers[id] == nil, isDownloading(id) else { return }
    downloadWatchers[id] = Task { [weak self] in
      defer { self?.downloadWatchers[id] = nil }
      for _ in 0..<Self.downloadWatchLimit {
        guard !Task.isCancelled, let self else { return }
        await self.refreshAudioState(id)
        guard self.isDownloading(id) else { return }
        do {
          try await Task.sleep(for: .seconds(1))
        } catch {
          // Cancelled: the answer this watch was waiting for is no longer wanted.
          return
        }
      }
    }
  }

  /// Ends every watch, so nothing keeps asking a service this device has left.
  private func stopDownloadWatches() {
    for watcher in downloadWatchers.values {
      watcher.cancel()
    }
    downloadWatchers.removeAll()
  }

  /// The player this screen drives. One player for the model, because only one Set
  /// plays at a time and the lock screen follows whatever it holds.
  private(set) var audioPlayer = AudioPlayer()

  /// True while a Set is playing now. This is what makes replacing the queue worth a question:
  /// replacing a queue nobody is listening to interrupts nothing.
  var isPlayingNow: Bool {
    audioPlayer.currentSetId != nil && audioPlayer.state == .playing
  }

  /// The player reports the end of a Set here, because finishing the Listen and starting what the
  /// queue holds next are the model's to do.
  private func wirePlayerToQueue() {
    audioPlayer.onFinished = { [weak self] setId in
      Task { await self?.finishedPlaying(setId) }
    }
  }

  // MARK: - Playback through the Listening Queue

  /// Plays a Set from where it left off, and makes it the active entry so both devices agree on
  /// what is playing. Every play goes through the queue for that reason: a Listen is an activation
  /// on Vanta, not a local press.
  func playSet(_ id: String) async {
    guard let client else { return }
    queueNotice = nil
    do {
      let loaded = try await client.playSet(id)
      publishQueue(loaded)
      guard let playing = loaded.entries.first(where: { $0.id == id }) else { return }
      audioPlayer.play(
        set: playing, baseURL: client.address, token: client.token,
        startAt: playing.resumePosition)
      startReportingPosition(id)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Puts a Set in the queue to play after the one playing now.
  func playNext(_ id: String) async {
    await queueSet(id, placement: .next, notice: "Plays next")
  }

  /// Adds a Set to the end of the queue.
  func addToQueue(_ id: String) async {
    await queueSet(id, placement: .end, notice: "Added to the queue")
  }

  private func queueSet(
    _ id: String, placement: QueuePlacement, notice: String
  ) async {
    guard let client else { return }
    queueNotice = nil
    do {
      publishQueue(try await client.queueSet(id, placement: placement))
      queueNotice = notice
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Replaces the queue with a Playlist's playable members, in Playlist order, and starts the
  /// first of them. A Playlist with no playable member leaves the queue empty, which stops
  /// playback: the queue no longer holds the Set that was playing.
  func playPlaylist(_ id: String) async {
    guard let client else { return }
    queueNotice = nil
    do {
      let loaded = try await client.playPlaylist(id)
      publishQueue(loaded)
      start(loaded, from: client)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Plays the active entry of a queue, or stops when it holds none.
  private func start(_ loaded: ListeningQueue, from client: OrbisClient) {
    guard let active = loaded.active else {
      audioPlayer.stop()
      stopReportingPosition()
      return
    }
    audioPlayer.play(
      set: active, baseURL: client.address, token: client.token,
      startAt: active.resumePosition)
    startReportingPosition(active.id)
  }

  /// The active Set reached its natural end. The Listen finishes on Vanta, the queue advances, and
  /// whatever it holds next starts here, which is what lets a queue play on untouched. An empty
  /// queue stops.
  func finishedPlaying(_ id: String) async {
    guard let client else { return }
    stopReportingPosition()
    do {
      let loaded = try await client.reportCompletion(id)
      publishQueue(loaded)
      // The finished Set left the queue and its position went back to the beginning, so the
      // Library is read again rather than patched. Read quietly, because a spinner where the list
      // was would be a flicker the person did not ask for.
      await refreshLibraryQuietly()
      start(loaded, from: client)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Reads the one Listening Queue. A failure keeps its reason, so the queue screen can say what
  /// went wrong and offer the retry where the answer belongs.
  func loadQueue() async {
    guard let client else { return }
    queueGeneration += 1
    let generation = queueGeneration
    do {
      let loaded = try await client.listeningQueue()
      guard generation == queueGeneration, !Task.isCancelled else { return }
      queue = .loaded(loaded)
    } catch OrbisError.cancelled {
      guard generation == queueGeneration else { return }
      queue = .idle
    } catch let error as OrbisError {
      guard generation == queueGeneration else { return }
      queue = .failed(error.failure(at: client.address))
    } catch {
      guard generation == queueGeneration else { return }
      queue = .failed(OrbisError.unreachable.failure(at: client.address))
    }
  }

  private func publishQueue(_ loaded: ListeningQueue) {
    queue = .loaded(loaded)
  }

  // MARK: - Playback Position

  /// Follows the player and reports where it has reached, so the other device resumes from the same
  /// place. When a position is news belongs to `PositionReporting`, which holds the bound.
  private func startReportingPosition(_ id: String) {
    stopReportingPosition()
    var reports = PositionReporting()
    positionReporter = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: PositionReporting.interval)
        } catch {
          // Cancelled: another Set owns the position now.
          return
        }
        guard let self, self.audioPlayer.currentSetId == id else { return }
        let state = self.audioPlayer.state
        guard
          let seconds = reports.position(
            elapsed: self.audioPlayer.elapsed, state: state)
        else { continue }
        await self.reportPosition(
          id, seconds: seconds, settled: PositionReporting.settles(state))
      }
    }
  }

  private func stopReportingPosition() {
    positionReporter?.cancel()
    positionReporter = nil
  }

  /// Sends one Playback Position. A report while the Set is still playing stays in the player: the
  /// Library holds the position for a row's progress bar, and rebuilding that list every five
  /// seconds would redraw the screen for a bar nobody is watching. A report that settles — a pause
  /// or a stop — is published, because that is the value the row and the other device should show.
  private func reportPosition(_ id: String, seconds: Int, settled: Bool) async {
    guard let client else { return }
    guard let updated = try? await client.reportPosition(id, seconds: seconds) else { return }
    if settled {
      await publish(updated)
    }
  }

  /// Reads the library again without blanking it. A change the person did not make on this screen —
  /// a completion, a settled position — must not put a spinner where the list was.
  func refreshLibraryQuietly() async {
    guard let client else { return }
    libraryGeneration += 1
    let generation = libraryGeneration
    guard let sets = try? await client.library(playlistId: selectedPlaylistId) else { return }
    guard generation == libraryGeneration, !Task.isCancelled else { return }
    library = .loaded(sets)
  }

  /// What the mini player's button does. Pausing and resuming stay inside the player, because the
  /// Set is already the active one and pausing is part of the same Listen.
  func togglePlayback() {
    switch audioPlayer.state {
    case .playing:
      audioPlayer.pause()
    case .loading, .paused:
      audioPlayer.resume()
    case .idle, .failed:
      // Nothing loaded to resume, so the button starts the Set the player still names.
      if let id = audioPlayer.currentSetId {
        Task { await playSet(id) }
      }
    }
  }

  /// What a row's artwork control does: pauses or resumes the Set in the player, and starts
  /// any other. One entry point, so a row never has to know which it is pressing.
  func togglePlayback(_ id: String) {
    guard audioPlayer.currentSetId == id else {
      Task { await playSet(id) }
      return
    }
    if audioPlayer.state == .playing {
      audioPlayer.pause()
    } else {
      audioPlayer.resume()
    }
  }

  /// Closes the reveal, leaving nothing behind when the person filed the Set and walked away.
  func closeReveal(with set: SavedSet? = nil) {
    guard let closed = set ?? reveal?.set else {
      reveal = nil
      revealFailure = nil
      return
    }
    reveal = nil
    revealFailure = nil
    fileConfirmation = "Filed “\(closed.title)”"
  }

  /// Swaps one Set in the loaded library for a newer copy of it. While the Library is
  /// showing one playlist, a Set that moved out of it leaves the list; keeping the row
  /// would say the move did nothing. Answers whether the loaded library took the change.
  @discardableResult
  private func replace(_ set: SavedSet) -> Bool {
    guard case .loaded(let sets) = library else { return false }
    if let selectedPlaylistId, !set.playlistIds.contains(selectedPlaylistId) {
      library = .loaded(sets.filter { $0.id != set.id })
    } else {
      library = .loaded(sets.map { $0.id == set.id ? set : $0 })
    }
    return true
  }

  /// Publishes a Set the service accepted. A write that lands while the library is already being
  /// loaded has nothing to swap into, and the load in flight may have read the Set before the
  /// write, so the list is read again rather than the change being dropped.
  private func publish(_ set: SavedSet) async {
    guard !replace(set) else { return }
    if case .loading = library {
      await loadLibrary()
    }
  }

  // MARK: - One Set's page

  /// The Set whose page is open. Held as an identifier rather than a copy, so an edit shows on
  /// the page and a removal closes it instead of leaving a stale Set on screen.
  var openedSetId: String?

  /// What the last change from the page said. The Set stays where it is and the message stays
  /// in front of the person, who can try the same action again.
  var setFailure: OrbisFailure?
  var isWorkingOnSet = false

  func savedSet(_ id: String) -> SavedSet? {
    guard case .loaded(let sets) = library else { return nil }
    return sets.first { $0.id == id }
  }

  func openSet(_ id: String) {
    setFailure = nil
    openedSetId = id
  }

  func closeSet() {
    setFailure = nil
    openedSetId = nil
  }

  /// Runs one change from the page. Every path reports through `setError`, so a refusal is
  /// readable where the action was taken and nothing disappears before it is understood.
  private func change(
    _ id: String, _ work: (OrbisClient) async throws -> SavedSet
  ) async {
    guard let client else { return }
    isWorkingOnSet = true
    setFailure = nil
    defer { isWorkingOnSet = false }
    do {
      await publish(try await work(client))
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  func rename(_ id: String, to title: String) async {
    let trimmed = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    guard !trimmed.isEmpty, trimmed != savedSet(id)?.title else { return }
    await change(id) { try await $0.updateTitle(id, title: trimmed) }
  }

  func replaceTags(_ id: String, with tags: [String]) async {
    guard tags != savedSet(id)?.tags else { return }
    await change(id) { try await $0.updateTags(id, tags: tags) }
  }

  /// Moves a Set to a Playlist, or out of every one. Orbis holds a Set in one Playlist, so
  /// choosing another is a move rather than a second membership.
  func move(_ id: String, to playlistId: String?) async {
    let wanted = playlistId.map { [$0] } ?? []
    guard wanted != savedSet(id)?.playlistIds else { return }
    await change(id) { try await $0.updatePlaylists(id, playlistIds: wanted) }
  }

  func nameAgain(_ id: String) async {
    await change(id) { try await $0.retryMetadata(id) }
  }

  func remove(_ id: String) async {
    guard let client else { return }
    isWorkingOnSet = true
    setFailure = nil
    defer { isWorkingOnSet = false }
    do {
      let removed = try await client.deleteSet(id)
      if case .loaded(let sets) = library {
        library = .loaded(sets.filter { $0.id != removed.id })
      }
      if openedSetId == removed.id {
        closeSet()
      }
      // A removed Set leaves the queue with it, so the queue is read again rather than patched.
      await loadQueue()
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// The playlists a sidebar offers. A failure keeps its reason and a retry, because an
  /// empty section reads as "no playlists" and sends a person relaunching the app instead
  /// of trying again where the answer belongs.
  func loadPlaylists() async {
    guard let client else { return }
    playlistGeneration += 1
    let generation = playlistGeneration
    playlists = .loading
    do {
      let items = try await client.playlists()
      // Forget clears the sidebar too, so an answer already out cannot put the old service's
      // Playlists back into a device that no longer holds it.
      guard generation == playlistGeneration, !Task.isCancelled else { return }
      playlists = .loaded(items)
    } catch OrbisError.cancelled {
      guard generation == playlistGeneration else { return }
      playlists = .idle
    } catch let error as OrbisError {
      guard generation == playlistGeneration else { return }
      playlists = .failed(error.failure(at: client.address))
    } catch {
      guard generation == playlistGeneration else { return }
      playlists = .failed(OrbisError.unreachable.failure(at: client.address))
    }
  }

  func selectPlaylist(_ id: String?) async {
    guard selectedPlaylistId != id else { return }
    selectedPlaylistId = id
    await loadLibrary()
  }

  /// The Playlist whose ordered members the Playlists destination is showing.
  var openedPlaylistId: String?

  /// The ordered Sets in the opened Playlist, loaded apart from the Library filter so a tab
  /// change does not disturb what another screen is showing.
  var playlistMembers: Loadable<[SavedSet]> = .idle

  /// What the last Playlist change refused, kept where the action was taken.
  var playlistFailure: OrbisFailure?
  var isWorkingOnPlaylist = false

  func playlist(_ id: String) -> Playlist? {
    playlistItems.first { $0.id == id }
  }

  func openPlaylist(_ id: String) {
    playlistFailure = nil
    openedPlaylistId = id
  }

  func closePlaylist() {
    playlistFailure = nil
    openedPlaylistId = nil
    playlistMembers = .idle
  }

  func loadPlaylistMembers(_ id: String) async {
    guard let client else { return }
    playlistMembers = .loading
    do {
      let sets = try await client.library(playlistId: id)
      guard openedPlaylistId == id, !Task.isCancelled else { return }
      playlistMembers = .loaded(sets)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      guard openedPlaylistId == id else { return }
      playlistMembers = .failed(error.failure(at: client.address))
    } catch {
      guard openedPlaylistId == id else { return }
      playlistMembers = .failed(OrbisError.unreachable.failure(at: client.address))
    }
  }

  private func playlistChange(_ work: (OrbisClient) async throws -> Void) async {
    guard let client else { return }
    isWorkingOnPlaylist = true
    playlistFailure = nil
    defer { isWorkingOnPlaylist = false }
    do {
      try await work(client)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      playlistFailure = error.failure(at: client.address)
    } catch {
      playlistFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  /// Creates a Playlist and opens it when the service accepts the name.
  func createPlaylist(named name: String) async -> Playlist? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard let client else { return nil }
    isWorkingOnPlaylist = true
    playlistFailure = nil
    defer { isWorkingOnPlaylist = false }
    do {
      let created = try await client.createPlaylist(name: trimmed)
      await loadPlaylists()
      openPlaylist(created.id)
      await loadPlaylistMembers(created.id)
      return created
    } catch OrbisError.cancelled {
      return nil
    } catch let error as OrbisError {
      playlistFailure = error.failure(at: client.address)
      return nil
    } catch {
      playlistFailure = OrbisError.unreachable.failure(at: client.address)
      return nil
    }
  }

  func renamePlaylist(_ id: String, to name: String) async {
    let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
    guard !trimmed.isEmpty, trimmed != playlist(id)?.name else { return }
    await playlistChange { client in
      _ = try await client.renamePlaylist(id, name: trimmed)
      await loadPlaylists()
      if selectedPlaylistId == id {
        await loadLibrary()
      }
      if openedPlaylistId == id {
        await loadPlaylistMembers(id)
      }
    }
  }

  func deletePlaylist(_ id: String) async {
    await playlistChange { client in
      _ = try await client.deletePlaylist(id)
      if selectedPlaylistId == id {
        selectedPlaylistId = nil
        await loadLibrary()
      }
      if openedPlaylistId == id {
        closePlaylist()
      }
      await loadPlaylists()
    }
  }

  func replacePlaylistMembers(_ playlistId: String, with setIds: [String]) async {
    guard case .loaded(let current) = playlistMembers, openedPlaylistId == playlistId else {
      return
    }
    guard setIds != current.map(\.id) else { return }
    await playlistChange { client in
      let sets = try await client.setPlaylistMembers(playlistId, setIds: setIds)
      guard openedPlaylistId == playlistId else { return }
      playlistMembers = .loaded(sets)
      await loadPlaylists()
      await refreshLibraryAfterPlaylistChange(playlistId: playlistId, sets: sets)
    }
  }

  func addSetToPlaylist(_ playlistId: String, setId: String) async {
    guard case .loaded(let current) = playlistMembers, openedPlaylistId == playlistId else {
      return
    }
    guard !current.contains(where: { $0.id == setId }) else { return }
    await replacePlaylistMembers(playlistId, with: current.map(\.id) + [setId])
  }

  func removeSetFromPlaylist(_ playlistId: String, setId: String) async {
    guard case .loaded(let current) = playlistMembers, openedPlaylistId == playlistId else {
      return
    }
    await replacePlaylistMembers(
      playlistId, with: current.filter { $0.id != setId }.map(\.id))
  }

  func movePlaylistMembers(
    _ playlistId: String, from source: IndexSet, to destination: Int
  ) async {
    guard case .loaded(let current) = playlistMembers, openedPlaylistId == playlistId else {
      return
    }
    var ids = current.map(\.id)
    ids.move(fromOffsets: source, toOffset: destination)
    await replacePlaylistMembers(playlistId, with: ids)
  }

  private func refreshLibraryAfterPlaylistChange(
    playlistId: String, sets: [SavedSet]
  ) async {
    if selectedPlaylistId == playlistId {
      library = .loaded(sets)
      return
    }
    guard case .loaded(let librarySets) = library else { return }
    let returned = Dictionary(uniqueKeysWithValues: sets.map { ($0.id, $0) })
    library = .loaded(librarySets.map { returned[$0.id] ?? $0 })
  }

  func runSearch() async {
    guard let client else { return }
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      clearSearch()
      return
    }
    searchGeneration += 1
    let generation = searchGeneration
    search = .loading
    searchResultsFor = query
    do {
      let sets = try await client.library(query: query)
      guard generation == searchGeneration, !Task.isCancelled else { return }
      search = .loaded(sets)
    } catch OrbisError.cancelled {
      guard generation == searchGeneration else { return }
      search = .idle
      searchResultsFor = nil
    } catch let error as OrbisError {
      guard generation == searchGeneration else { return }
      search = .failed(error.failure(at: client.address))
    } catch {
      guard generation == searchGeneration else { return }
      search = .failed(OrbisError.unreachable.failure(at: client.address))
    }
  }

  /// Empties the search: the field, the results, and the name they answer to go together. A
  /// cleared field cannot leave a heading naming results that are no longer on screen, and the
  /// screen returns to the state it shows before anything was typed rather than waiting on a
  /// request that was never sent.
  func clearSearch() {
    searchGeneration += 1
    searchQuery = ""
    search = .idle
    searchResultsFor = nil
  }
}

enum Destination: String, CaseIterable, Identifiable, Hashable {
  case home = "Home"
  case library = "Library"
  case playlists = "Playlists"
  case search = "Search"

  /// Identity is the destination itself, so a list binding can select the case directly.
  var id: Self { self }

  /// Search is a tab role on iPhone and is not repeated in the sidebar list.
  static var shellCases: [Destination] {
    allCases.filter { $0 != .search }
  }

  var symbol: String {
    switch self {
    case .home: "house"
    case .library: "music.note.list"
    case .playlists: "rectangle.stack"
    case .search: "magnifyingglass"
    }
  }
}
