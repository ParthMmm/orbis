import OrbisDesign
import SwiftUI

/// People (ADR 0009): the invite while the signed-in Person has Social off; once it is on, who is
/// listening now and everyone in the Group with Social on, each opening their own page.
struct PeopleDestination: View {
  @Bindable var model: AppModel
  @State private var people: PeopleModel
  @State private var openedPerson: String?

  init(model: AppModel) {
    self.model = model
    _people = State(initialValue: PeopleModel(app: model))
  }

  var body: some View {
    content
      .sidebarPageTitle("People")
      .largeTitleOnIOS()
      // Runs on every appearance, so Social turned on in Settings shows when People opens again.
      .task(id: model.client?.token) { await people.load() }
      .task(id: PresenceKey(token: model.client?.token, social: people.isSocial)) {
        await people.watchPresence()
      }
      .navigationDestination(item: $openedPerson) { id in
        PersonScreen(model: model, people: people, personId: id)
      }
  }

  @ViewBuilder
  private var content: some View {
    switch people.me {
    case .idle, .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.orbis.paper)
    case .failed(let failure):
      UnavailableState(failure: failure, context: "loading People") {
        Task { await people.load() }
      }
    case .loaded(let me) where !me.social:
      SocialInvite { Task { await people.turnOn() } }
        .safeAreaInset(edge: .bottom) {
          if let failure = people.failure {
            Text(failure.message)
              .font(.orbis.detail)
              .foregroundStyle(OrbisColor.destructive)
              .padding()
              .accessibilityIdentifier("people-error")
          }
        }
    case .loaded:
      page
    }
  }

  private var page: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        if people.people.isEmpty {
          emptyCard
        } else {
          group
        }
        if let failure = people.failure {
          Text(failure.message)
            .font(.orbis.detail)
            .foregroundStyle(OrbisColor.destructive)
            .accessibilityIdentifier("people-error")
        }
      }
      .padding(.horizontal)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .refreshable { await people.load() }
    .background {
      ArtworkGlow(
        url: people.listening.first.flatMap { SetPresentation.pageArtwork($0.set) }, reach: 0.6)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("people-list")
  }

  // MARK: Your Group

  /// One list of the Group. Whoever is listening comes first, with what they are playing and a
  /// button to play it here; everyone else shows what they played last.
  private var group: some View {
    let ordered = people.people.sorted { first, second in
      (people.presence(of: first.id) != nil) && (people.presence(of: second.id) == nil)
    }
    return VStack(alignment: .leading, spacing: 10) {
      SectionHeading("Your Group", subtitle: "People who share with the Group.")
      VStack(spacing: 0) {
        ForEach(ordered) { person in
          PersonRow(
            model: model, person: person, presence: people.presence(of: person.id),
            lastListen: people.lastListens[person.id]
          ) { openedPerson = person.id }
          .accessibilityIdentifier("person-\(person.username)")
          if person.id != ordered.last?.id {
            Divider().padding(.leading, 72)
          }
        }
      }
      .background(.background, in: .rect(cornerRadius: 18))
    }
  }

  private var emptyCard: some View {
    VStack(spacing: 12) {
      Image(systemName: "person.badge.plus")
        .font(.system(size: 28))
        .foregroundStyle(Color.orbis.tint)
        .frame(width: 64, height: 64)
        .background(Color.orbis.tint.opacity(0.12), in: .circle)
        .accessibilityHidden(true)
      Text("Nobody else is sharing yet")
        .font(.orbis.title)
        .multilineTextAlignment(.center)
      Text("When someone in your Group turns on Share with Group, they show up here with what they are playing.")
        .font(.orbis.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 28)
    .frame(maxWidth: .infinity)
    .glassEffect(.regular, in: .rect(cornerRadius: 22))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("people-empty")
  }
}

/// One Person in the Group list: their disc, and what they are playing now or played last. A
/// Person listening now has a play button for the same Set.
private struct PersonRow: View {
  @Bindable var model: AppModel
  let person: PersonFilters
  let presence: Presence?
  let lastListen: Listen?
  let open: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Button(action: open) {
        HStack(spacing: 12) {
          PersonAvatar(person.username, isListening: presence != nil)
          VStack(alignment: .leading, spacing: 2) {
            Text(person.username)
              .font(.orbis.body.weight(.semibold))
            // The title gives way first, so "· 18h ago" always shows.
            HStack(spacing: 4) {
              Text(status)
                .lineLimit(1)
              if let when {
                Text("· \(when)")
                  .fixedSize()
              }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
          }
          Spacer(minLength: 8)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      if let set = presence?.set, set.downloadState == "ready" {
        playButton(set)
      } else {
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 68)
  }

  private var status: String {
    if !person.see { return "Hidden from you" }
    if let presence { return "Listening to \(presence.set.title)" }
    if let lastListen { return "Played \(lastListen.set.title)" }
    return "Nothing played yet"
  }

  /// How long ago the last Listen started, for a Person who can be seen and is not listening now.
  private var when: String? {
    guard person.see, presence == nil, let lastListen else { return nil }
    return SetPresentation.date(from: lastListen.startedAt)
      .formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
  }

  private func playButton(_ set: SavedSet) -> some View {
    let isPlaying = model.audioPlayer.currentSetId == set.id && model.audioPlayer.state == .playing
    return Button {
      model.togglePlayback(set.id)
    } label: {
      Image(systemName: isPlaying ? "pause.fill" : "play.fill")
        .font(.system(size: 13, weight: .bold))
        .frame(width: 20, height: 20)
        .contentTransition(.symbolEffect(.replace))
    }
    .buttonStyle(.glassProminent)
    .buttonBorderShape(.circle)
    .tint(Color.orbis.tint)
    .accessibilityLabel(isPlaying ? "Pause" : "Play \(set.title)")
  }
}

/// Keys the Presence stream, so it opens once Social is on and again for a new key.
private struct PresenceKey: Equatable {
  let token: String?
  let social: Bool
}

// MARK: - One Person

/// A friend's page: who they are, what they are playing, what they played lately, their
/// Playlists and Library, and the two switches between the two of you.
struct PersonScreen: View {
  @Bindable var model: AppModel
  let people: PeopleModel
  let personId: String
  @State private var friend: FriendModel?
  @State private var openedPlaylist: FriendPlaylist?

  private var person: PersonFilters? { people.people.first { $0.id == personId } }

  var body: some View {
    ScrollView {
      if let person {
        VStack(alignment: .leading, spacing: 32) {
          header(person)
          if let presence = people.presence(of: personId), person.see {
            nowPlaying(presence)
          }
          if person.see {
            libraryContent(person)
          } else {
            Text("Turn See on to see \(person.username)’s Library, Playlists and listening.")
              .font(.orbis.body)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity)
              .multilineTextAlignment(.center)
          }
          switches(person)
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
      } else {
        ContentUnavailableView(
          "Not in your People", systemImage: "person.crop.circle.badge.questionmark",
          description: Text("They stopped sharing with the Group, or left it."))
      }
    }
    .refreshable { await friend?.load() }
    .background {
      ArtworkGlow(
        url: people.presence(of: personId).flatMap { SetPresentation.pageArtwork($0.set) }, reach: 0.6)
    }
    .navigationTitle(person?.username ?? "")
    .toolbarTitleDisplayMode(.inline)
    .task(id: person?.see) {
      guard person?.see == true else { return }
      let loaded = friend ?? FriendModel(app: model, personId: personId)
      friend = loaded
      await loaded.load()
    }
    .sheet(item: $openedPlaylist) { playlist in
      FriendPlaylistSheet(model: model, playlist: playlist)
    }
    .accessibilityIdentifier("person-page")
  }

  private func header(_ person: PersonFilters) -> some View {
    VStack(spacing: 10) {
      PersonAvatar(person.username, diameter: 96)
        .overlay { Circle().strokeBorder(.white.opacity(0.8), lineWidth: 4) }
        .shadow(color: .black.opacity(0.2), radius: 14, y: 8)
      Text(person.username)
        .font(.largeTitle.bold())
      if let counts = friend?.counts {
        Text(counts)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 8)
  }

  private func nowPlaying(_ presence: Presence) -> some View {
    let set = presence.set
    let isCurrent = model.audioPlayer.currentSetId == set.id
    let isPlaying = isCurrent && model.audioPlayer.state == .playing
    return VStack(alignment: .leading, spacing: 12) {
      Label("Listening now", systemImage: "circle.fill")
        .labelStyle(.titleAndIcon)
        .font(.caption.weight(.bold))
        .textCase(.uppercase)
        .tracking(1.2)
        .foregroundStyle(.green)
        .imageScale(.small)
      Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
        .shadow(color: .black.opacity(0.3), radius: 16, y: 10)
      VStack(alignment: .leading, spacing: 2) {
        Text(set.title)
          .font(.orbis.title)
          .lineLimit(2)
        if let creator = set.creator, !creator.isEmpty {
          Text(creator)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      HStack(spacing: 10) {
        if set.downloadState == "ready" {
          Button {
            model.togglePlayback(set.id)
          } label: {
            Label(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill")
              .font(.headline)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          .controlSize(.large)
          .accessibilityIdentifier("person-play-now")
        }
        saveButton(set)
      }
    }
    .padding(12)
    .glassEffect(.regular, in: .rect(cornerRadius: 24))
  }

  /// Save while the Set is not in the signed-in Person's Library; once it is, a quiet note in
  /// place of a button that could only look disabled.
  @ViewBuilder
  private func saveButton(_ set: SavedSet) -> some View {
    if model.savedSet(set.id) != nil || friend?.savedIds.contains(set.id) == true {
      Label("In Library", systemImage: "checkmark")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .accessibilityIdentifier("person-save-now")
    } else {
      Button {
        Task { await friend?.save(set) }
      } label: {
        Label("Save", systemImage: "plus")
          .font(.headline)
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glass)
      .controlSize(.large)
      .accessibilityIdentifier("person-save-now")
    }
  }

  @ViewBuilder
  private func libraryContent(_ person: PersonFilters) -> some View {
    switch friend?.state ?? .loading {
    case .idle, .loading:
      ProgressView().frame(maxWidth: .infinity)
    case .failed(let failure):
      UnavailableState(failure: failure, context: "loading \(person.username)’s Library") {
        Task { await friend?.load() }
      }
    case .loaded(let content):
      // Each Set shows once: the one playing now leaves Recently played, and Sets in Recently
      // played leave the Library list.
      let playingId = people.presence(of: personId)?.set.id
      let recent = content.recent.filter { $0.set.id != playingId }
      let shown = Set(recent.map(\.set.id)).union([playingId].compactMap { $0 })
      let library = content.sets.filter { !shown.contains($0.id) }
      if !recent.isEmpty {
        rail("Recently played") {
          ForEach(recent, id: \.startedAt) { listen in
            Button {
              play(listen.set)
            } label: {
              SetCard(
                title: listen.set.title,
                detail: SetPresentation.date(from: listen.startedAt).formatted(.relative(presentation: .named)),
                artwork: SetPresentation.row(listen.set).artwork)
            }
            .buttonStyle(.orbisPressable)
            .contextMenu { setMenu(listen.set) }
          }
        }
      }
      if !content.playlists.isEmpty {
        VStack(alignment: .leading, spacing: 14) {
          SectionHeading("Playlists")
          LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)],
            spacing: 18
          ) {
            ForEach(content.playlists) { playlist in
              Button {
                openedPlaylist = playlist
              } label: {
                PlaylistSleeve(
                  name: playlist.name, count: playlist.setCount,
                  artwork: playlist.sets.prefix(3).map { SetPresentation.row($0).artwork },
                  category: SetPresentation.category(for: playlist.name))
              }
              .buttonStyle(.orbisPressable)
            }
          }
        }
      }
      if content.sets.isEmpty || !library.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          SectionHeading("Library", subtitle: content.sets.isEmpty ? "Nothing saved yet." : nil)
          LazyVStack(spacing: 0) {
            ForEach(library) { set in
              FriendSetRow(model: model, set: set) { play(set) }
                .contextMenu { setMenu(set) }
            }
          }
        }
      }
    }
  }

  private func switches(_ person: PersonFilters) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeading("Between you")
      VStack(spacing: 0) {
        Toggle(isOn: filter(person, \.see) { SocialFiltersUpdate(see: $0) }) {
          VStack(alignment: .leading, spacing: 2) {
            Text("See \(person.username)")
            Text("Their Sets, Playlists, and listening show here").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("people-see-\(person.username)")
        .padding(.vertical, 10)
        Divider()
        Toggle(isOn: filter(person, \.appear) { SocialFiltersUpdate(appear: $0) }) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Share with \(person.username)")
            Text("They see your Sets, Playlists, and listening").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("people-appear-\(person.username)")
        .padding(.vertical, 10)
      }
      .padding(.horizontal, 16)
      .background(Color.orbis.paperRaised, in: .rect(cornerRadius: 16))
      .disabled(people.isSaving)
      Text("You can see \(person.username) without sharing with them.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
    }
  }

  private func filter(
    _ person: PersonFilters, _ value: KeyPath<PersonFilters, Bool>,
    _ update: @escaping (Bool) -> SocialFiltersUpdate
  ) -> Binding<Bool> {
    Binding(
      get: { person[keyPath: value] },
      set: { enabled in Task { await people.setFilters(for: person.id, update(enabled)) } })
  }

  @ViewBuilder
  private func setMenu(_ set: SavedSet) -> some View {
    if set.downloadState == "ready" {
      Button("Play", systemImage: "play.fill") { play(set) }
    }
    if model.savedSet(set.id) == nil {
      Button("Save to Library", systemImage: "plus") { Task { await friend?.save(set) } }
    }
  }

  private func play(_ set: SavedSet) {
    guard set.downloadState == "ready" else { return }
    model.togglePlayback(set.id)
  }

  private func rail<Cards: View>(
    _ name: String, @ViewBuilder cards: () -> Cards
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading(name)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) { cards() }
          .padding(.horizontal, 16)
          .scrollTargetLayout()
      }
      .padding(.horizontal, -16)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
  }
}

/// A Set in a friend's Library: artwork, title and who made it. Tapping plays it when its audio is
/// on the service; one that is not shows that it cannot play yet.
private struct FriendSetRow: View {
  @Bindable var model: AppModel
  let set: SavedSet
  let play: () -> Void

  private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }

  var body: some View {
    Button(action: play) {
      HStack(spacing: 12) {
        Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .row)
        VStack(alignment: .leading, spacing: 2) {
          Text(set.title)
            .font(.orbis.body.weight(.medium))
            .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
            .lineLimit(1)
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 7)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityHint(set.downloadState == "ready" ? "Plays this Set" : "Not downloaded yet")
  }

  private var detail: String {
    let parts = [set.creator, set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil }]
      .compactMap { $0 }.filter { !$0.isEmpty }
    let line = parts.joined(separator: " · ")
    if set.downloadState != "ready" { return line.isEmpty ? "Not downloaded" : "\(line) · Not downloaded" }
    return line
  }
}

/// One of a friend's Playlists, as a sheet of its Sets.
private struct FriendPlaylistSheet: View {
  @Bindable var model: AppModel
  let playlist: FriendPlaylist
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List(playlist.sets) { set in
        FriendSetRow(model: model, set: set) {
          if set.downloadState == "ready" { model.togglePlayback(set.id) }
        }
      }
      .listStyle(.plain)
      .overlay {
        if playlist.sets.isEmpty {
          ContentUnavailableView("This Playlist is empty", systemImage: "music.note.list")
        }
      }
      .navigationTitle(playlist.name)
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

// MARK: - Models

/// What People shows and the requests that change it.
@MainActor
@Observable
final class PeopleModel {
  private let app: AppModel
  var me: Loadable<Me> = .idle
  var people: [PersonFilters] = []
  /// What visible People are playing now, as the event stream last said.
  var listening: [Presence] = []
  /// Each seen Person's newest Listen, for the row of someone not listening now.
  var lastListens: [String: Listen] = [:]
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
      lastListens = [:]
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

  /// Follows the event stream while People is on screen, reconnecting after a drop. Only the
  /// People this Person sees are kept, because See is decided here and the stream does not know it.
  func watchPresence() async {
    guard isSocial else {
      listening = []
      return
    }
    while !Task.isCancelled {
      guard let client = app.client else { return }
      do {
        try await client.watchPresence { [weak self] presence in
          guard let self else { return }
          let seen = Set(self.people.filter(\.see).map(\.id))
          self.listening = presence.filter { seen.contains($0.personId) }
        }
      } catch OrbisError.notSignedIn {
        return
      } catch {
        if Task.isCancelled { return }
      }
      try? await Task.sleep(for: .seconds(2))
    }
  }

  private func loadPeople() async {
    if let list = await settingsRequest(app, { self.failure = $0 }, { try await $0.socialFilters() }) {
      people = list
      let seen = Set(list.filter(\.see).map(\.id))
      listening = listening.filter { seen.contains($0.personId) }
      await loadLastListens(for: seen)
    }
  }

  /// One small request per seen Person, run together. A failure leaves that row on its fallback,
  /// because a missing "played lately" line is not worth an error on the page.
  private func loadLastListens(for ids: Set<String>) async {
    guard let client = app.client else { return }
    lastListens = await withTaskGroup(of: (String, Listen?).self) { group in
      for id in ids {
        group.addTask { (id, try? await client.friendListens(id).first) }
      }
      var newest: [String: Listen] = [:]
      for await (id, listen) in group {
        if let listen { newest[id] = listen }
      }
      return newest
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

  var counts: String? {
    guard case .loaded(let content) = state else { return nil }
    // A zero says nothing a missing count does not, so only the counts that have something show.
    var parts: [String] = []
    switch content.sets.count {
    case 0: break
    case 1: parts.append("1 Set")
    case let n: parts.append("\(n) Sets")
    }
    switch content.playlists.count {
    case 0: break
    case 1: parts.append("1 Playlist")
    case let n: parts.append("\(n) Playlists")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
