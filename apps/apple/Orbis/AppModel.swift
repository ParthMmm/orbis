import Foundation
import Observation
import OrbisDesign

#if canImport(UIKit)
  import UIKit
#endif

enum Loadable<Value: Equatable>: Equatable {
  case idle
  case loading
  case loaded(Value)
  case failed(OrbisFailure)

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

  let serviceAddress: URL

  var isSigningIn = false
  var signInFailure: OrbisFailure?

  var isShowingSettings = false

  var library: Loadable<[SavedSet]> = .idle {
    didSet { refreshDerivedState() }
  }
  var playlists: Loadable<[Playlist]> = .idle
  var queue: Loadable<ListeningQueue> = .idle
  var queueNotice: String?
  private(set) var tracklists: [String: Tracklist] = [:]
  var selectedPlaylistId: String?
  var searchQuery = ""
  var search: Loadable<[SavedSet]> = .idle

  private(set) var searchResultsFor: String?

  var activeTag: String? {
    didSet { refreshDerivedState() }
  }

  var activeCreator: CreatorFilter? {
    didSet { refreshDerivedState() }
  }

  private(set) var availableTags: [String] = []

  private(set) var tagCounts: [String: Int] = [:]

  var librarySort: LibrarySort = .newest

  private(set) var visibleSets: Loadable<[SavedSet]> = .idle

  private func refreshDerivedState() {
    guard case .loaded(let sets) = library else {
      availableTags = []
      tagCounts = [:]
      visibleSets = library
      return
    }
    tagCounts = SetPresentation.tagCounts(sets)
    availableTags = tagCounts.keys.sorted()
    visibleSets = .loaded(
      sets.filter { set in
        (activeTag.map(set.tags.contains) ?? true) && (activeCreator?.admits(set) ?? true)
      })
  }

  private var reloadsAfterCancellation = 0

  private var libraryGeneration = 0
  private var searchGeneration = 0
  private var playlistGeneration = 0
  private var queueGeneration = 0
  private var tracklistGeneration = 0

  var linkToFile = ""
  var isFiling = false
  var pasteNotice: String?
  var fileConfirmation: String?
  var fileFailure: OrbisError?

  struct Reveal: Equatable {
    let set: SavedSet
    var title: String
    var tags: [String]

    var renamedTitle: String? {
      let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)
      guard !trimmed.isEmpty, String(trimmed) != set.title else { return nil }
      return String(trimmed)
    }

    var titleUntouched: Bool {
      title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title == set.title
    }

    var hasChanges: Bool { renamedTitle != nil || tags != set.tags }
  }

  var reveal: Reveal?
  var isSavingReveal = false
  var revealFailure: OrbisFailure?

  var audioStates: [String: AudioState] = [:]

  private var downloadWatchers: [String: Task<Void, Never>] = [:]

  private static let downloadWatchLimit = 600

  var destination: Destination = .home
  var searchFocusRequests = 0

  private let settings: any ClientSettingsStore

  private var positionReporter: Task<Void, Never>?

  private let session: URLSession

  init(
    settings: any ClientSettingsStore = ClientSettings.forCurrentProcess(),
    session: URLSession = .shared
  ) {
    self.settings = settings
    self.session = session
    let arguments = ProcessInfo.processInfo.arguments
    Self.resetSettings(ifRequestedBy: arguments, in: settings)
    #if DEBUG
      Self.signIn(ifRequestedBy: arguments, in: settings)
    #endif
    if let flag = arguments.firstIndex(of: "-orbisStartTagFiltered"),
      arguments.indices.contains(flag + 1)
    {
      activeTag = arguments[flag + 1]
    }
    serviceAddress = OrbisService.address(for: arguments)
    client = settings.configuredClient(address: serviceAddress, session: session)
    refreshDerivedState()
    wirePlayerToQueue()
  }

  init(client: OrbisClient, settings: any ClientSettingsStore) {
    self.settings = settings
    self.client = client
    session = client.session
    serviceAddress = client.address
    refreshDerivedState()
    wirePlayerToQueue()
  }

  static func resetSettings(ifRequestedBy arguments: [String], in settings: any ClientSettingsStore) {
    guard arguments.contains("-orbisResetSettings") else { return }
    settings.store(deviceToken: nil)
  }

  #if DEBUG
    static func signIn(ifRequestedBy arguments: [String], in settings: any ClientSettingsStore) {
      guard let flag = arguments.firstIndex(of: "-orbisSignedInWith"),
        arguments.indices.contains(flag + 1)
      else { return }
      settings.store(deviceToken: arguments[flag + 1])
    }
  #endif

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

  func showCreator(of set: SavedSet) {
    guard let name = set.creator, !name.isEmpty else { return }
    activeCreator = CreatorFilter(id: set.creatorId, name: name)
    openedSets = [:]
    destination = .library
  }

  var isFilteringLibrary: Bool { activeTag != nil || activeCreator != nil }

  func clearLibraryFilters() {
    activeTag = nil
    activeCreator = nil
  }

  enum SignIn {
    case join(username: String, passcode: String)
    case code(String)
  }

  func signIn(_ request: SignIn) async {
    guard !isSigningIn else { return }
    signInFailure = nil
    isSigningIn = true
    defer { isSigningIn = false }
    let signedOut = OrbisClient(address: serviceAddress, token: "", session: session)
    let label = String(Self.deviceLabel.prefix(100))
    let key: String
    do {
      switch request {
      case .join(let username, let passcode):
        key = try await signedOut.join(
          username: username.trimmingCharacters(in: .whitespacesAndNewlines),
          passcode: passcode.trimmingCharacters(in: .whitespacesAndNewlines), label: label)
      case .code(let typed):
        key = try await signedOut.redeem(code: SignInCode.normalized(typed), label: label)
      }
    } catch {
      signInFailure = OrbisFailure.explaining(error, at: serviceAddress)
      return
    }
    guard settings.store(deviceToken: key) else {
      signInFailure = OrbisError.storageRefused.failure(at: serviceAddress)
      return
    }
    client = OrbisClient(address: serviceAddress, token: key, session: session)
    await loadLibrary()
    await loadPlaylists()
    await loadQueue()
  }

  private static var deviceLabel: String {
    #if canImport(UIKit)
      "Orbis on \(UIDevice.current.name)"
    #else
      "Orbis on \(Host.current().localizedName ?? "Mac")"
    #endif
  }

  func signOut() {
    libraryGeneration += 1
    searchGeneration += 1
    playlistGeneration += 1
    queueGeneration += 1
    audioPlayer.stop()
    stopDownloadWatches()
    stopReportingPosition()
    audioStates.removeAll()
    tracklistGeneration += 1
    tracklists.removeAll()
    settings.store(deviceToken: nil)
    client = nil
    signInFailure = nil
    isShowingSettings = false
    destination = .home
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
    activeCreator = nil
    openedSets = [:]
    reveal = nil
    revealFailure = nil
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
      for set in sets where isDownloading(set.id) {
        watchDownload(set.id)
      }
    } catch OrbisError.cancelled {
      guard generation == libraryGeneration, !Task.isCancelled else { return }
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
      reveal = Reveal(
        set: saved,
        title: saved.metadataState == "failed" ? "" : saved.title,
        tags: saved.tags
      )
      if case .loaded(let sets) = library {
        libraryGeneration += 1
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

  func pasteAndFile(_ text: String) async {
    pasteNotice = nil
    guard let url = LinkField.address(of: text), SetSource.named(by: url) != nil else {
      pasteNotice = "The clipboard holds no YouTube or SoundCloud link."
      return
    }
    linkToFile = text.trimmingCharacters(in: .whitespacesAndNewlines)
    await fileLink()
  }

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

  func retryMetadata() async {
    guard !isSavingReveal else { return }
    guard let client, let open = reveal else { return }
    isSavingReveal = true
    revealFailure = nil
    defer { isSavingReveal = false }
    do {
      let updated = try await client.retryMetadata(open.set.id)
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

  func refreshAudioState(_ id: String) async {
    guard let client else { return }
    guard let state = try? await client.audioState(id) else { return }
    audioStates[id] = state
    if state.state == "ready" || state.state == "failed" {
      await refreshLibraryQuietly()
      audioStates[id] = nil
    }
  }

  private func isDownloading(_ id: String) -> Bool {
    ["queued", "downloading"].contains(savedSet(id)?.downloadState ?? "none")
  }

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
          return
        }
      }
    }
  }

  private func stopDownloadWatches() {
    for watcher in downloadWatchers.values {
      watcher.cancel()
    }
    downloadWatchers.removeAll()
  }

  private(set) var audioPlayer = AudioPlayer()

  var isPlayingNow: Bool {
    audioPlayer.currentSetId != nil && audioPlayer.state == .playing
  }

  private func wirePlayerToQueue() {
    audioPlayer.onFinished = { [weak self] setId in
      Task { await self?.finishedPlaying(setId) }
    }
  }

  func playSet(_ id: String, startAt: TimeInterval? = nil) async {
    guard let client else { return }
    queueNotice = nil
    do {
      let loaded = try await client.playSet(id)
      queue = .loaded(loaded)
      guard let playing = loaded.entries.first(where: { $0.id == id }) else { return }
      audioPlayer.play(
        set: playing, baseURL: client.address, token: client.token,
        startAt: startAt ?? playing.resumePosition)
      attachTracklist(to: playing)
      startReportingPosition(id)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  func playCue(_ cue: Cue, in id: String) async {
    guard let seconds = cue.startSeconds else { return }
    if audioPlayer.currentSetId == id {
      audioPlayer.seek(to: seconds)
    } else {
      await playSet(id, startAt: seconds)
    }
  }

  private func attachTracklist(to set: SavedSet) {
    audioPlayer.setCues(tracklists[set.id]?.cues ?? [])
    if set.tracklistState != .none,
      tracklists[set.id] == nil || tracklists[set.id]?.state == .pending
    {
      Task { await loadTracklist(set.id) }
    }
  }

  func loadTracklist(_ id: String) async {
    guard let client else { return }
    let generation = tracklistGeneration
    do {
      for _ in 0..<60 {
        guard generation == tracklistGeneration, !Task.isCancelled else { return }
        let tracklist = try await client.tracklist(id)
        guard generation == tracklistGeneration, !Task.isCancelled else { return }
        tracklists[id] = tracklist
        if audioPlayer.currentSetId == id { audioPlayer.setCues(tracklist.cues) }
        guard tracklist.state == .pending else { return }
        try await Task.sleep(for: .seconds(1))
      }
    } catch is CancellationError {
      return
    } catch OrbisError.cancelled {
      return
    } catch {
      if generation == tracklistGeneration, tracklists[id]?.state != .ready {
        tracklists[id] = Tracklist(state: .failed, cues: [])
      }
    }
  }

  func retryTracklist(_ id: String) async {
    guard let client else { return }
    let generation = tracklistGeneration
    do {
      let tracklist = try await client.retryTracklist(id)
      guard generation == tracklistGeneration, !Task.isCancelled else { return }
      tracklists[id] = tracklist
      if audioPlayer.currentSetId == id { audioPlayer.setCues(tracklist.cues) }
      if tracklist.state == .pending { await loadTracklist(id) }
    } catch OrbisError.cancelled {
      return
    } catch {
      if generation == tracklistGeneration {
        tracklists[id] = Tracklist(state: .failed, cues: [])
      }
    }
  }

  func playNext(_ id: String) async {
    await queueSet(id, placement: .next, notice: "Plays next")
  }

  func addToQueue(_ id: String) async {
    await queueSet(id, placement: .end, notice: "Added to the queue")
  }

  private func queueSet(
    _ id: String, placement: QueuePlacement, notice: String
  ) async {
    guard let client else { return }
    queueNotice = nil
    do {
      queue = .loaded(try await client.queueSet(id, placement: placement))
      queueNotice = notice
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  func playPlaylist(_ id: String) async {
    guard let client else { return }
    queueNotice = nil
    do {
      let loaded = try await client.playPlaylist(id)
      queue = .loaded(loaded)
      playActiveEntry(of: loaded, from: client)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  private func playActiveEntry(of loaded: ListeningQueue, from client: OrbisClient) {
    guard let active = loaded.active else {
      audioPlayer.stop()
      stopReportingPosition()
      return
    }
    audioPlayer.play(
      set: active, baseURL: client.address, token: client.token,
      startAt: active.resumePosition)
    attachTracklist(to: active)
    startReportingPosition(active.id)
  }

  func finishedPlaying(_ id: String) async {
    guard let client else { return }
    stopReportingPosition()
    do {
      let loaded = try await client.reportCompletion(id)
      queue = .loaded(loaded)
      await refreshLibraryQuietly()
      playActiveEntry(of: loaded, from: client)
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

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

  private func startReportingPosition(_ id: String) {
    stopReportingPosition()
    var reports = PositionReporting()
    positionReporter = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: PositionReporting.interval)
        } catch {
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

  private func reportPosition(_ id: String, seconds: Int, settled: Bool) async {
    guard let client else { return }
    guard let updated = try? await client.reportPosition(id, seconds: seconds) else { return }
    if settled {
      await publish(updated)
    }
  }

  func refreshLibraryQuietly() async {
    guard let client else { return }
    libraryGeneration += 1
    let generation = libraryGeneration
    guard let sets = try? await client.library(playlistId: selectedPlaylistId) else { return }
    guard generation == libraryGeneration, !Task.isCancelled else { return }
    library = .loaded(sets)
  }

  func togglePlayback() {
    switch audioPlayer.state {
    case .playing:
      audioPlayer.pause()
    case .loading, .paused:
      audioPlayer.resume()
    case .idle, .failed:
      if let id = audioPlayer.currentSetId {
        Task { await playSet(id) }
      }
    }
  }

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

  private func publish(_ set: SavedSet) async {
    guard !replace(set) else { return }
    if case .loading = library {
      await loadLibrary()
    }
  }

  var openedSets: [Destination: String] = [:]

  var showsMiniPlayer: Bool {
    guard let current = audioPlayer.currentSetId else { return false }
    return openedSetId != current
  }

  var openedSetId: String? {
    get { openedSets[destination] }
    set { openedSets[destination] = newValue }
  }

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

  func move(_ id: String, to playlistId: String?) async {
    let wanted = playlistId.map { [$0] } ?? []
    guard wanted != savedSet(id)?.playlistIds else { return }
    await change(id) { try await $0.updatePlaylists(id, playlistIds: wanted) }
  }

  func setMembership(_ id: String, in playlistId: String, _ included: Bool) async {
    guard let current = savedSet(id)?.playlistIds else { return }
    var wanted = current.filter { $0 != playlistId }
    if included { wanted.append(playlistId) }
    guard wanted != current else { return }
    await change(id) { try await $0.updatePlaylists(id, playlistIds: wanted) }
    guard setFailure == nil else { return }
    await refreshPlaylistsQuietly()
  }

  func refreshPlaylistsQuietly() async {
    guard let client else { return }
    playlistGeneration += 1
    let generation = playlistGeneration
    guard let items = try? await client.playlists(),
      generation == playlistGeneration, !Task.isCancelled
    else { return }
    playlists = .loaded(items)
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
      if openedSets.values.contains(removed.id) {
        setFailure = nil
        openedSets = openedSets.filter { $0.value != removed.id }
      }
      await loadQueue()
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

  func loadPlaylists() async {
    guard let client else { return }
    playlistGeneration += 1
    let generation = playlistGeneration
    playlists = .loading
    do {
      let items = try await client.playlists()
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

  var openedPlaylistId: String?

  var playlistMembers: Loadable<[SavedSet]> = .idle

  var playlistFailure: OrbisFailure?
  var isWorkingOnPlaylist = false

  func playlist(_ id: String) -> Playlist? {
    playlistItems.first { $0.id == id }
  }

  func openPlaylist(_ id: String) {
    playlistFailure = nil
    openedSets[.playlists] = nil
    playlistMembers = .idle
    openedPlaylistId = id
  }

  func showPlaylist(_ id: String) {
    destination = .playlists
    openPlaylist(id)
    Task { [weak self] in await self?.loadPlaylistMembers(id) }
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

  func playlistSets(_ id: String) async -> Loadable<[SavedSet]> {
    guard let client else { return .idle }
    do {
      return .loaded(try await client.library(playlistId: id))
    } catch let error as OrbisError {
      return .failed(error.failure(at: client.address))
    } catch {
      return .failed(OrbisError.unreachable.failure(at: client.address))
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

  func createPlaylist(named name: String, opening: Bool = true) async -> Playlist? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard let client else { return nil }
    isWorkingOnPlaylist = true
    playlistFailure = nil
    defer { isWorkingOnPlaylist = false }
    do {
      let created = try await client.createPlaylist(name: trimmed)
      guard opening else {
        await refreshPlaylistsQuietly()
        return created
      }
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

  func cueMatches(for query: String) -> [CueMatch] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty, case .loaded(let sets) = library else { return [] }
    return sets.flatMap { set in
      (tracklists[set.id]?.cues ?? [])
        .filter {
          $0.title.localizedCaseInsensitiveContains(query)
            || $0.artist.localizedCaseInsensitiveContains(query)
        }
        .map { CueMatch(set: set, cue: $0) }
    }
  }

  func loadTracklistsForSearch() async {
    guard let client, case .loaded(let sets) = library else { return }
    let missing = sets.filter { $0.tracklistState == .ready && tracklists[$0.id] == nil }.map(\.id)
    await withTaskGroup(of: (String, Tracklist?).self) { group in
      var pending = missing[...]
      for _ in 0..<4 {
        guard let id = pending.popFirst() else { break }
        group.addTask { (id, try? await client.tracklist(id)) }
      }
      while let (id, tracklist) = await group.next() {
        if let tracklist { tracklists[id] = tracklist }
        if let next = pending.popFirst() {
          group.addTask { (next, try? await client.tracklist(next)) }
        }
      }
    }
  }

  func shufflePlaylist(_ id: String) async {
    guard let client, case .loaded(let members) = playlistMembers else { return }
    let order = members.filter { $0.downloadState == "ready" }.shuffled()
    guard let first = order.first else { return }
    await playSet(first.id)
    do {
      for set in order.dropFirst() {
        queue = .loaded(try await client.queueSet(set.id, placement: .end))
      }
    } catch OrbisError.cancelled {
      return
    } catch let error as OrbisError {
      setFailure = error.failure(at: client.address)
    } catch {
      setFailure = OrbisError.unreachable.failure(at: client.address)
    }
  }

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
  case people = "People"
  case search = "Search"

  var id: Self { self }

  static var shellCases: [Destination] {
    allCases.filter { $0 != .search }
  }

  var symbol: String {
    switch self {
    case .home: "house"
    case .library: "music.note.list"
    case .playlists: "rectangle.stack"
    case .people: "person.2"
    case .search: "magnifyingglass"
    }
  }
}

struct CueMatch: Identifiable {
  let set: SavedSet
  let cue: Cue
  var id: String { "\(set.id)-\(cue.position)" }
}

enum LibrarySort: String, CaseIterable, Identifiable {
  case newest = "Newest"
  case title = "Title"
  case longest = "Longest"

  var id: Self { self }

  func ordered(_ sets: [SavedSet]) -> [SavedSet] {
    switch self {
    case .newest: sets
    case .title: sets.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    case .longest: sets.sorted { ($0.durationSeconds ?? 0) > ($1.durationSeconds ?? 0) }
    }
  }
}

struct CreatorFilter: Hashable {
  let id: String?
  let name: String

  func admits(_ set: SavedSet) -> Bool {
    if let id, let setId = set.creatorId { return id == setId }
    return set.creator == name
  }
}
