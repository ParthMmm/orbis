import OrbisDesign
import SwiftUI

/// People (ADR 0009): the invite while the signed-in Person has Social off; once it is on, who is
/// listening now and everyone in the Group with Social on, each opening their own page.
struct PeopleDestination: View {
  @Bindable var model: AppModel
  @State private var people: PeopleModel
  @State private var openedPerson: String?
  /// A Person's page zooms out of what was tapped: their listening card or their disc. Someone
  /// listening shows as both, so the id says which.
  @Namespace private var personZoom
  @State private var personZoomID: String?
  @ScaledMetric(relativeTo: .title) private var emptyBadgeSide: CGFloat = 64

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
          .zoomTransition(from: personZoomID ?? id, in: personZoom)
      }
      .onChange(of: model.peopleRootRequests) { openedPerson = nil }
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
        MacPageTitle.slot("People")
        if people.people.isEmpty {
          emptyCard
        } else {
          listeningNow
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

  // MARK: Listening now

  /// Who is listening now, one compact card each, dressed in the Set's artwork.
  @ViewBuilder
  private var listeningNow: some View {
    if !people.listening.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        SectionHeading("Listening now")
        ForEach(people.listening, id: \.personId) { presence in
          ListeningCard(model: model, presence: presence) {
            personZoomID = "listening/\(presence.personId)"
            openedPerson = presence.personId
          }
          .zoomSource("listening/\(presence.personId)", in: personZoom, cornerRadius: 22)
          .accessibilityIdentifier("listening-\(presence.username)")
        }
      }
    }
  }

  // MARK: Your Group

  /// Everyone in the Group as a row of discs with their names. Whoever is listening leads, marked
  /// by the green dot.
  private var group: some View {
    let ordered = people.people.sorted { first, second in
      (people.presence(of: first.id) != nil) && (people.presence(of: second.id) == nil)
    }
    return VStack(alignment: .leading, spacing: 12) {
      SectionHeading("Your Group")
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 18) {
          ForEach(ordered) { person in
            let isListening = people.presence(of: person.id) != nil
            Button {
              personZoomID = "group/\(person.id)"
              openedPerson = person.id
            } label: {
              VStack(spacing: 8) {
                PersonAvatar(person.username, diameter: 68, isListening: isListening)
                  .zoomSource("group/\(person.id)", in: personZoom, cornerRadius: 34)
                  .shadow(color: .black.opacity(0.15), radius: 10, y: 6)
                Text(person.username)
                  .font(.footnote.weight(.semibold))
                  .lineLimit(1)
              }
              .frame(width: 76)
            }
            .buttonStyle(.orbisPressable)
            .accessibilityLabel(isListening ? "\(person.username), listening now" : person.username)
            .accessibilityIdentifier("person-\(person.username)")
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
      }
      .padding(.horizontal, -16)
      .scrollIndicators(.hidden)
      .scrollClipDisabled()
    }
  }

  private var emptyCard: some View {
    VStack(spacing: 12) {
      Image(systemName: "person.badge.plus")
        .font(.title)
        .foregroundStyle(Color.orbis.tint)
        .frame(width: emptyBadgeSide, height: emptyBadgeSide)
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
    .orbisRaised(radius: Radius.hero)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("people-empty")
  }
}

/// A Person listening now: the Set's artwork on a blur of itself, who is listening with a
/// moving waveform, and a button to play the same Set here.
private struct ListeningCard: View {
  @Bindable var model: AppModel
  let presence: Presence
  let open: () -> Void
  @ScaledMetric(relativeTo: .subheadline) private var playSide: CGFloat = 26

  private var set: SavedSet { presence.set }
  private var artwork: URL? { SetPresentation.pageArtwork(set) }
  private var isPlaying: Bool {
    model.audioPlayer.currentSetId == set.id && model.audioPlayer.state == .playing
  }

  var body: some View {
    HStack(spacing: 12) {
      Button(action: open) {
        HStack(spacing: 12) {
          Artwork(url: artwork, seed: set.title, size: .lead)
            .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
            // Who is listening, tucked on the corner of what they are playing.
            .overlay(alignment: .bottomTrailing) {
              PersonAvatar(presence.username, diameter: 28)
                .padding(2)
                .background(.black.opacity(0.55), in: .circle)
                .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
                .offset(x: 8, y: 8)
            }
            .padding(.trailing, 4)
          VStack(alignment: .leading, spacing: 4) {
            listener
            Text(set.title)
              .font(.orbis.body.weight(.semibold))
              .lineLimit(2)
            if let creator = set.creator, !creator.isEmpty {
              Text(creator)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(1)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityLabel("\(presence.username) is listening to \(set.title)")
      .accessibilityHint("Opens \(presence.username)")
      if set.downloadState == "ready" {
        playButton
      }
    }
    .padding(12)
    .artworkCard(artwork, cornerRadius: 22)
  }

  /// "▮▮▮ pp is listening": bars that keep moving while they listen, standing on the text's
  /// baseline.
  private var listener: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      LiveBars()
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
      Text("\(Text(presence.username).foregroundStyle(.white).fontWeight(.semibold)) is listening")
        .font(.footnote)
        .foregroundStyle(.white.opacity(0.7))
        .lineLimit(1)
    }
  }

  private var playButton: some View {
    Button {
      model.togglePlayback(set.id)
    } label: {
      Image(systemName: isPlaying ? "pause.fill" : "play.fill")
        .font(.subheadline.weight(.bold))
        .frame(width: playSide, height: playSide)
        .contentTransition(.symbolEffect(.replace))
    }
    .buttonStyle(.glassProminent)
    .buttonBorderShape(.circle)
    .tint(Color.orbis.tint)
    .accessibilityLabel(isPlaying ? "Pause" : "Play \(set.title)")
  }
}

extension View {
  /// Sets the view on a blur of a Set's artwork, in white text, so the card takes the colour of
  /// its Set in light and dark mode alike.
  fileprivate func artworkCard(_ artwork: URL?, cornerRadius: CGFloat) -> some View {
    foregroundStyle(.white)
      .background { ArtworkBackdrop(url: artwork) }
      .clipShape(.rect(cornerRadius: cornerRadius))
      .overlay {
        RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(.white.opacity(0.12), lineWidth: 1)
      }
      .environment(\.colorScheme, .dark)
  }
}

private struct ArtworkBackdrop: View {
  let url: URL?

  var body: some View {
    ZStack {
      Color.black
      AsyncImage(url: url) { image in
        image
          .resizable()
          .aspectRatio(contentMode: .fill)
          .blur(radius: 40, opaque: true)
          .saturation(1.6)
          .scaleEffect(1.4)
      } placeholder: {
        Color.orbis.tint.opacity(0.5)
      }
      LinearGradient(
        colors: [.black.opacity(0.15), .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
    }
  }
}

/// A symbol and its value set close together, the symbol a step quieter.
private struct StatLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) {
      configuration.icon.foregroundStyle(.tertiary)
      configuration.title
    }
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
  /// A Playlist's sheet zooms out of its folder.
  @Namespace private var playlistZoom
  @State private var showsTitle = false
  @ScaledMetric(relativeTo: .body) private var switchGlyphSize: CGFloat = 14
  @ScaledMetric(relativeTo: .body) private var switchBadgeSide: CGFloat = 30

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
    // The name sits in the bar only once the header's name has scrolled away.
    .navigationTitle(showsTitle ? person?.username ?? "" : "")
    .toolbarTitleDisplayMode(.inline)
    .task(id: person?.see) {
      guard person?.see == true else { return }
      let loaded = friend ?? FriendModel(app: model, personId: personId)
      friend = loaded
      await loaded.load()
    }
    .sheet(item: $openedPlaylist) { playlist in
      FriendPlaylistSheet(model: model, playlist: playlist)
        .zoomTransition(from: playlist.id, in: playlistZoom)
    }
    .accessibilityIdentifier("person-page")
  }

  private func header(_ person: PersonFilters) -> some View {
    VStack(spacing: 10) {
      PersonAvatar(person.username, diameter: 96)
        .overlay { Circle().strokeBorder(.white.opacity(0.8), lineWidth: 4) }
        .shadow(color: .black.opacity(0.2), radius: 14, y: 8)
      VStack(spacing: 4) {
        Text(person.username)
          .font(.largeTitle.bold())
          .onGeometryChange(for: Bool.self) {
            $0.frame(in: .scrollView).maxY < 0
          } action: {
            showsTitle = $0
          }
      }
      stats(person)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 8)
  }

  /// One quiet row of symbols: how many Sets and Playlists they keep, when they last played, and
  /// whether the two of you share both ways. Zero counts and a last play while they are listening
  /// (the card below says so) are left out.
  private func stats(_ person: PersonFilters) -> some View {
    let content: FriendModel.Content? =
      if person.see, case .loaded(let content) = friend?.state { content } else { nil }
    let lastPlayed: String? =
      if people.presence(of: personId) == nil, let last = content?.recent.first {
        SetPresentation.date(from: last.startedAt)
          .formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
      } else { nil }
    return HStack(spacing: 18) {
      if let sets = content?.sets.count, sets > 0 {
        stat("\(sets)", symbol: "music.note.list", label: sets == 1 ? "1 Set" : "\(sets) Sets")
      }
      if let playlists = content?.playlists.count, playlists > 0 {
        stat(
          "\(playlists)", symbol: "rectangle.stack",
          label: playlists == 1 ? "1 Playlist" : "\(playlists) Playlists")
      }
      if let lastPlayed {
        stat(lastPlayed, symbol: "clock", label: "Played \(lastPlayed)")
      }
      sharing(see: person.see, appear: person.appear)
    }
    .font(.subheadline.weight(.medium))
    .foregroundStyle(.secondary)
    .imageScale(.small)
    .monospacedDigit()
  }

  /// How the two switches below stand, as one symbol: the same eye and wave the switches use,
  /// and the tint when sharing goes both ways. VoiceOver reads it in words.
  private func sharing(see: Bool, appear: Bool) -> some View {
    let (symbol, label): (String, String) =
      switch (see, appear) {
      case (true, true): ("arrow.left.arrow.right", "Sharing with each other")
      case (true, false): ("eye", "You see them. They don’t see you.")
      case (false, true): ("person.wave.2", "They see you. You don’t see them.")
      case (false, false): ("eye.slash", "Not sharing")
      }
    return Image(systemName: symbol)
      .foregroundStyle(see && appear ? AnyShapeStyle(Color.orbis.tint) : AnyShapeStyle(.tertiary))
      .accessibilityLabel(label)
      .accessibilityIdentifier("person-relationship")
  }

  private func stat(_ value: String, symbol: String, label: String) -> some View {
    Label(value, systemImage: symbol)
      .labelStyle(StatLabelStyle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(label)
  }

  private func nowPlaying(_ presence: Presence) -> some View {
    let set = presence.set
    let artwork = SetPresentation.pageArtwork(set)
    let isPlaying = model.audioPlayer.currentSetId == set.id && model.audioPlayer.state == .playing
    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        LiveBars()
          .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
        Text("Listening now")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.white.opacity(0.8))
      }
      Artwork(url: artwork, seed: set.title, size: .header)
        .shadow(color: .black.opacity(0.35), radius: 16, y: 10)
      VStack(alignment: .leading, spacing: 2) {
        Text(set.title)
          .font(.orbis.title)
          .lineLimit(2)
        if let creator = set.creator, !creator.isEmpty {
          Text(creator)
            .font(.subheadline)
            .foregroundStyle(.white.opacity(0.7))
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
    .padding(16)
    .artworkCard(artwork, cornerRadius: 28)
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
          // Two folders across a phone, as on Home; a Mac window fits more rather than stretching
          // two.
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 14)], spacing: 18) {
            ForEach(content.playlists) { playlist in
              Button {
                openedPlaylist = playlist
              } label: {
                PlaylistSleeve(
                  name: playlist.name, count: playlist.setCount,
                  artwork: playlist.sets.prefix(3).map { SetPresentation.row($0).artwork },
                  category: SetPresentation.category(for: playlist.name)
                )
                .zoomSource(playlist.id, in: playlistZoom, cornerRadius: 20)
              }
              .buttonStyle(.orbisPressable)
            }
          }
        }
      }
      if recent.isEmpty && content.playlists.isEmpty && library.isEmpty && playingId == nil {
        Text("\(person.username) hasn’t saved or played anything yet.")
          .font(.orbis.body)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .multilineTextAlignment(.center)
      }
      if !library.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          SectionHeading("Library")
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
    VStack(alignment: .leading, spacing: 10) {
      SectionHeading("Between you")
      VStack(spacing: 0) {
        switchRow(
          "See \(person.username)", detail: "Their Sets, Playlists, and listening", symbol: "eye.fill",
          isOn: filter(person, \.see) { SocialFiltersUpdate(see: $0) }
        )
        .accessibilityIdentifier("people-see-\(person.username)")
        Divider().padding(.leading, 58)
        switchRow(
          "Share with \(person.username)", detail: "Your Sets, Playlists, and listening",
          symbol: "person.wave.2.fill", isOn: filter(person, \.appear) { SocialFiltersUpdate(appear: $0) }
        )
        .accessibilityIdentifier("people-appear-\(person.username)")
      }
      .background(Color.orbis.paperRaised, in: .rect(cornerRadius: 18))
      .disabled(people.isSaving)
    }
  }

  private func switchRow(
    _ title: String, detail: String, symbol: String, isOn: Binding<Bool>
  ) -> some View {
    Toggle(isOn: isOn) {
      HStack(spacing: 12) {
        Image(systemName: symbol)
          .font(.system(size: switchGlyphSize, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: switchBadgeSide, height: switchBadgeSide)
          .background(Color.orbis.tint.gradient, in: .rect(cornerRadius: 8))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
          Text(detail)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
    }
    .tint(Color.orbis.tint)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
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
