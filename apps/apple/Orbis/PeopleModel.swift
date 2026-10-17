import Foundation
import Observation
import OrbisDesign

/// What People shows and the requests that change it.
@MainActor
@Observable
final class PeopleModel {
  private let app: AppModel
  var me: Loadable<Me> = .idle
  var people: [PersonFilters] = [] {
    didSet { seen = Set(people.filter(\.see).map(\.id)) }
  }
  /// The People this Person sees, kept with `people` so a Presence frame does not rebuild it.
  @ObservationIgnored private var seen: Set<String> = []
  /// What visible People are playing now, as the event stream last said.
  var listening: [Presence] = []
  /// How long to wait before the event stream reconnects. Doubles with each drop, and starts over
  /// once a stream delivers a frame.
  @ObservationIgnored private var reconnectDelay = PeopleModel.firstReconnectDelay
  private static let firstReconnectDelay = Duration.seconds(2)
  private static let longestReconnectDelay = Duration.seconds(60)
  var failure: OrbisFailure?
  var isSaving = false
  private var loadedToken: String?

  init(app: AppModel) {
    self.app = app
  }

  var isSocial: Bool {
    if case .loaded(let person) = me { person.social } else { false }
  }

  func presence(of personId: String) -> Presence? {
    listening.first { $0.personId == personId }
  }

  /// Reads `/me` each time, not once: Social is switched in Settings too, and a stale answer is
  /// what kept this screen on the invite after Social was on.
  func load() async {
    guard app.isConfigured else { return }
    if loadedToken != app.client?.token {
      loadedToken = app.client?.token
      me = .idle
      people = []
      listening = []
      failure = nil
    }
    if case .loaded = me {} else { me = .loading }
    guard
      let person = await settingsRequest(
        app, { if let failure = $0 { self.me = .failed(failure) } }, { try await $0.me() })
    else { return }
    if person.social { await loadPeople() }
    me = .loaded(person)
  }

  func turnOn() async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    guard
      let person = await settingsRequest(
        app, { self.failure = $0 }, { try await $0.updateMe(MeUpdate(social: true)) })
    else { return }
    await loadPeople()
    me = .loaded(person)
  }

  func setFilters(for personId: String, _ update: SocialFiltersUpdate) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    guard
      let saved = await settingsRequest(
        app, { self.failure = $0 }, { try await $0.setFilters(for: personId, update) }),
      let index = people.firstIndex(where: { $0.id == personId })
    else { return }
    people[index].see = saved.see
    people[index].appear = saved.appear
  }

  /// Follows the event stream while People is on screen, reconnecting after a drop, and waiting
  /// longer after each drop in a row so a service that is down is not asked every two seconds. Only
  /// the People this Person sees are kept, because See is decided here and the stream does not know
  /// it.
  func watchPresence() async {
    guard isSocial else {
      listening = []
      return
    }
    reconnectDelay = Self.firstReconnectDelay
    while !Task.isCancelled {
      guard let client = app.client else { return }
      do {
        try await client.watchPresence { [weak self] presence in
          guard let self else { return }
          self.reconnectDelay = Self.firstReconnectDelay
          self.listening = presence.filter { self.seen.contains($0.personId) }
        }
      } catch OrbisError.notSignedIn {
        return
      } catch OrbisError.server(let status, _)
        where (400..<500).contains(status) && status != 408 && status != 429
      {
        // A refusal says the same thing on every try.
        return
      } catch {
        if Task.isCancelled { return }
      }
      try? await Task.sleep(for: reconnectDelay)
      reconnectDelay = min(reconnectDelay * 2, Self.longestReconnectDelay)
    }
  }

  private func loadPeople() async {
    if let list = await settingsRequest(app, { self.failure = $0 }, { try await $0.socialFilters() }) {
      people = list
      listening = listening.filter { seen.contains($0.personId) }
    }
  }
}

/// One friend's Library, Playlists and Listens, loaded together for their page.
@MainActor
@Observable
final class FriendModel {
  struct Content: Equatable {
    var sets: [SavedSet]
    var playlists: [FriendPlaylist]
    /// The newest Listen of each Set, so a Set played twice shows once.
    var recent: [Listen]
  }

  private let app: AppModel
  let personId: String
  var state: Loadable<Content> = .idle
  /// Sets saved from this page, so their button says so before the Library reloads.
  var savedIds: Set<String> = []

  init(app: AppModel, personId: String) {
    self.app = app
    self.personId = personId
  }

  func load() async {
    if case .loaded = state {} else { state = .loading }
    let id = personId
    let loaded = await settingsRequest(
      app, { if let failure = $0 { self.state = .failed(failure) } },
      { (client: OrbisClient) async throws -> ([SavedSet], [FriendPlaylist], [Listen]) in
        async let sets = client.friendSets(id)
        async let playlists = client.friendPlaylists(id)
        async let listens = client.friendListens(id)
        return try await (sets, playlists, listens)
      })
    guard let loaded else { return }
    let (sets, playlists, listens) = loaded
    var seen = Set<String>()
    let recent = listens.filter { seen.insert($0.set.id).inserted }.prefix(12)
    state = .loaded(Content(sets: sets, playlists: playlists, recent: Array(recent)))
  }

  /// Saves a friend's Set into the signed-in Person's own Library, by its link.
  func save(_ set: SavedSet) async {
    let saved = await settingsRequest(app, { _ in }, { try await $0.save(url: set.url) })
    if saved != nil {
      savedIds.insert(set.id)
      await app.refreshLibraryQuietly()
    }
  }
}
