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
  }

  /// A model already paired with a service. The launch screen and the settings file are the real
  /// path; this one exists so tests and previews can drive a change without either.
  init(client: OrbisClient, settings: any ClientSettingsStore) {
    self.settings = settings
    self.client = client
    connectionAddress = client.address.absoluteString
    hasStoredToken = settings.deviceToken?.isEmpty == false
    refreshDerivedState()
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
    // Audio still playing comes from a service this device no longer holds a token for, and a
    // download the old service is running is the same: nothing here may keep asking about it.
    audioPlayer.stop()
    stopDownloadWatches()
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
    selectedPlaylistId = nil
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

  /// Plays a downloaded Set through the player. A sync entry point: the view taps,
  /// the model pairs the Set with the service it came from.
  func playAudio(_ id: String) {
    guard let client, let set = savedSet(id) else { return }
    audioPlayer.play(set: set, baseURL: client.address, token: client.token)
  }

  /// What a row's artwork control does: pauses or resumes the Set in the player, and starts
  /// any other. One entry point, so a row never has to know which it is pressing.
  func togglePlayback(_ id: String) {
    guard audioPlayer.currentSetId == id else {
      playAudio(id)
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
  case search = "Search"

  /// Identity is the destination itself, so a list binding can select the case directly.
  var id: Self { self }

  var symbol: String {
    switch self {
    case .home: "house"
    case .library: "music.note.list"
    case .search: "magnifyingglass"
    }
  }
}
