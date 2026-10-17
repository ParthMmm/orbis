#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// People on the TV (ADR 0009): the invite while Social is off; once it is on, who is listening
  /// now as wide cards in their Set's light, and the Group as discs, each opening that Person's
  /// page. The See and Share switches stay on a phone or Mac, as the account does.
  struct TVPeople: View {
    @Bindable var model: AppModel
    let people: PeopleModel
    @State private var openedPerson: String?

    var body: some View {
      content
        .navigationDestination(item: $openedPerson) { id in
          TVPersonPage(model: model, people: people, personId: id).id(id)
        }
        .onChange(of: model.peopleRootRequests) { openedPerson = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tv-people")
    }

    @ViewBuilder private var content: some View {
      switch people.me {
      case .idle, .loading:
        TVPageState { TVLoading() }
          .background { TintGlow() }
          .accessibilityIdentifier("people-loading")
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading People") {
            Task { await people.load() }
          }
        }
        .background { TintGlow() }
        .accessibilityIdentifier("people-error")
      case .loaded(let me) where !me.social:
        TVSocialInvite(people: people)
      case .loaded:
        page
      }
    }

    private var page: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 48) {
          if people.people.isEmpty {
            TVPageState {
              ContentUnavailableView {
                Label("Nobody else is sharing yet", systemImage: "person.badge.plus")
              } description: {
                Text(
                  "When someone in your Group turns on Share with Group, they show up here with what they are playing."
                )
              }
            }
            .accessibilityIdentifier("people-empty")
          } else {
            if !people.listening.isEmpty {
              TVRail(title: "Listening now") {
                ForEach(people.listening, id: \.personId) { presence in
                  TVListeningCard(model: model, presence: presence) { openedPerson = presence.personId }
                    .accessibilityIdentifier("listening-\(presence.username)")
                }
              }
            }
            group
          }
          if let failure = people.failure {
            Text(failure.message)
              .font(.body)
              .foregroundStyle(OrbisColor.destructive)
              .accessibilityIdentifier("people-error")
          }
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        if let lead = people.listening.first {
          TVBackdrop(url: SetPresentation.pageArtwork(lead.set))
        } else {
          TintGlow()
        }
      }
    }

    /// Everyone in the Group as discs with their names, whoever is listening first.
    private var group: some View {
      let ordered = people.people.sorted { first, second in
        (people.presence(of: first.id) != nil) && (people.presence(of: second.id) == nil)
      }
      return VStack(alignment: .leading, spacing: 8) {
        SectionHeading("Your Group", subtitle: "Everyone sharing with the Group.")
        ScrollView(.horizontal) {
          LazyHStack(alignment: .top, spacing: 56) {
            ForEach(ordered) { person in
              let isListening = people.presence(of: person.id) != nil
              Button {
                openedPerson = person.id
              } label: {
                TVPersonDisc(username: person.username, isListening: isListening)
              }
              .buttonStyle(TVBareButtonStyle())
              .accessibilityLabel(isListening ? "\(person.username), listening now" : person.username)
              .accessibilityIdentifier("person-\(person.username)")
            }
          }
          .padding(.vertical, TVLayout.liftInset)
        }
        .scrollClipDisabled()
        .focusSection()
      }
    }
  }

  /// A Person as a large disc with their name under it. The disc grows and lifts under the remote,
  /// the way a poster does, since the system's card lift would frame a circle in a square.
  private struct TVPersonDisc: View {
    let username: String
    let isListening: Bool
    @Environment(\.isFocused) private var isFocused

    var body: some View {
      VStack(spacing: 20) {
        PersonAvatar(username, diameter: 170, isListening: isListening)
          .shadow(color: .black.opacity(isFocused ? 0.5 : 0.3), radius: isFocused ? 30 : 14, y: isFocused ? 20 : 8)
          .scaleEffect(isFocused ? 1.12 : 1)
        Text(username)
          .font(.title3.weight(.semibold))
          .foregroundStyle(isFocused ? Color.primary : Color.secondary)
          .lineLimit(1)
      }
      .frame(width: 210)
      .orbisAnimation(.pressed, value: isFocused)
    }
  }

  /// The label as it is: the view it wraps draws its own focus.
  struct TVBareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      configuration.label
    }
  }

  /// Someone listening now: the Set's artwork on a blur of itself, who is listening with bars that
  /// keep moving, and the Set's name. Pressing it opens that Person, where their Set plays here.
  /// Compact on Home, where it shares the screen with the rails.
  struct TVListeningCard: View {
    @Bindable var model: AppModel
    let presence: Presence
    var isCompact = false
    let open: () -> Void

    private var set: SavedSet { presence.set }
    private var artwork: URL? { SetPresentation.pageArtwork(set) }
    private var isHere: Bool { model.audioPlayer.currentSetId == set.id }

    var body: some View {
      Button(action: open) {
        HStack(spacing: isCompact ? 24 : 36) {
          Artwork(url: artwork, seed: set.title, size: .header)
            .frame(width: isCompact ? 240 : 380)
            .shadow(color: .black.opacity(0.4), radius: 18, y: 10)
            .overlay(alignment: .bottomTrailing) {
              PersonAvatar(presence.username, diameter: isCompact ? 44 : 60)
                .padding(3)
                .background(.black.opacity(0.55), in: .circle)
                .padding(10)
            }
          VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              LiveBars(height: 22)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
              Text("\(Text(presence.username).foregroundStyle(.white).fontWeight(.bold)) is listening")
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)
            }
            .font(isCompact ? .callout : .body)
            Text(set.title)
              .font(isCompact ? .headline : .title3.weight(.bold))
              .lineLimit(2)
            if !isCompact, let creator = set.creator, !creator.isEmpty {
              Text(creator)
                .font(.callout)
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(1)
            }
            if isHere {
              Label("Playing here too", systemImage: "hifispeaker.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.8))
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(isCompact ? 24 : 36)
        .frame(width: isCompact ? 640 : 860, height: isCompact ? 200 : 320)
        .foregroundStyle(.white)
        .background { TVArtworkCardBackdrop(url: artwork) }
        .environment(\.colorScheme, .dark)
      }
      .buttonStyle(.card)
      .accessibilityLabel("\(presence.username) is listening to \(set.title)")
      .accessibilityHint("Opens \(presence.username)")
    }
  }

  /// A Set's artwork blurred into the ground of a card, darkened at the bottom so white words read.
  struct TVArtworkCardBackdrop: View {
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
        LinearGradient(colors: [.black.opacity(0.1), .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
      }
      .accessibilityHidden(true)
    }
  }

  /// People while Social is off on the TV: what turning it on shows, and the one button that does.
  private struct TVSocialInvite: View {
    let people: PeopleModel

    var body: some View {
      HStack(alignment: .center, spacing: 96) {
        SleeveFan(seed: "people", artwork: [nil, nil, nil], category: .pink, width: 380)
          .frame(width: 640, height: 420)
          .overlay(alignment: .topLeading) { PersonAvatar("maya", diameter: 110).offset(x: 10, y: 40) }
          .overlay(alignment: .bottomTrailing) { PersonAvatar("jules", diameter: 110).offset(x: -20, y: -10) }
          .overlay(alignment: .bottomLeading) { PersonAvatar("sam", diameter: 84).offset(x: 140, y: 20) }
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 28) {
          Text("See what friends are playing")
            .font(.orbis.largeTitle)
            .accessibilityAddTraits(.isHeader)
          Text("Share with your Group to see each other's Sets, Playlists, and listening.")
            .font(.title3)
            .foregroundStyle(.secondary)
          VStack(alignment: .leading, spacing: 18) {
            Label("What they are listening to now, and lately", systemImage: "waveform")
            Label("Their Library and Playlists, to play or save", systemImage: "music.note.list")
            Label("You choose who sees you, one person at a time", systemImage: "checkmark.shield")
          }
          .font(.body)
          Button {
            Task { await people.turnOn() }
          } label: {
            Text("Share with Group")
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          .disabled(people.isSaving)
          .padding(.top, 12)
          .accessibilityIdentifier("social-turn-on")
          Text(people.failure?.message ?? "Nobody sees anything until you turn it on.")
            .font(.callout)
            .foregroundStyle(people.failure == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(OrbisColor.destructive))
            .accessibilityIdentifier("social-note")
        }
        .frame(maxWidth: 900, alignment: .leading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { TintGlow() }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("social-invite")
    }
  }

  /// A friend's page on the TV: who they are and what they keep, what they are playing now across
  /// the top in its own light with the button to play it here, then what they played lately, their
  /// Playlists' Sets, and their Library. Pressing a Set plays it here.
  struct TVPersonPage: View {
    @Bindable var model: AppModel
    let people: PeopleModel
    let personId: String
    @State private var friend: FriendModel?
    @FocusState private var focus: Focus?

    private enum Focus {
      case play
    }

    private var person: PersonFilters? { people.people.first { $0.id == personId } }
    private var presence: Presence? {
      guard person?.see == true else { return nil }
      return people.presence(of: personId)
    }

    var body: some View {
      Group {
        if let person {
          page(person)
        } else {
          ContentUnavailableView(
            "Not in your People", systemImage: "person.crop.circle.badge.questionmark",
            description: Text("They stopped sharing with the Group, or left it."))
        }
      }
      .task(id: person?.see) {
        guard person?.see == true else { return }
        let loaded = friend ?? FriendModel(app: model, personId: personId)
        friend = loaded
        await loaded.load()
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("person-page")
    }

    private func page(_ person: PersonFilters) -> some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 48) {
          header(person)
          if let presence {
            nowPlaying(presence)
          }
          if person.see {
            library(person)
          } else {
            TVPageState {
              ContentUnavailableView {
                Label("You don’t see \(person.username)", systemImage: "eye.slash")
              } description: {
                Text("Turn See on from Orbis on your iPhone or Mac to see their Library and listening here.")
              }
            }
          }
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        if let presence {
          TVBackdrop(url: SetPresentation.pageArtwork(presence.set))
        } else {
          TintGlow()
        }
      }
      .defaultFocus($focus, .play)
    }

    private func header(_ person: PersonFilters) -> some View {
      HStack(spacing: 36) {
        PersonAvatar(person.username, diameter: 150)
          .overlay { Circle().strokeBorder(.white.opacity(0.85), lineWidth: 5) }
          .shadow(color: .black.opacity(0.35), radius: 20, y: 12)
        VStack(alignment: .leading, spacing: 6) {
          Text(person.username)
            .font(.orbis.largeTitle)
            .accessibilityAddTraits(.isHeader)
          Text(summary(person))
            .font(.title3)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
      }
    }

    /// What they keep, and how the two of you share, on one quiet line.
    private func summary(_ person: PersonFilters) -> String {
      var parts: [String] = []
      if person.see, case .loaded(let content) = friend?.state {
        if !content.sets.isEmpty { parts.append(content.sets.count == 1 ? "1 Set" : "\(content.sets.count) Sets") }
        if !content.playlists.isEmpty {
          parts.append(content.playlists.count == 1 ? "1 Playlist" : "\(content.playlists.count) Playlists")
        }
      }
      let sharing =
        switch (person.see, person.appear) {
        case (true, true): "Sharing with each other"
        case (true, false): "You see them. They don’t see you."
        case (false, true): "They see you. You don’t see them."
        case (false, false): "Not sharing"
        }
      parts.append(sharing)
      return parts.joined(separator: " · ")
    }

    private func nowPlaying(_ presence: Presence) -> some View {
      let set = presence.set
      let isPlaying = model.audioPlayer.currentSetId == set.id && model.audioPlayer.state == .playing
      return HStack(alignment: .bottom, spacing: 80) {
        VStack(alignment: .leading, spacing: 16) {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            LiveBars(height: 22)
              .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
            Text("Listening now")
              .font(.callout.weight(.semibold))
              .foregroundStyle(.secondary)
          }
          Text(set.title)
            .font(.orbis.title)
            .lineLimit(2)
          if let creator = set.creator, !creator.isEmpty {
            Text(creator)
              .font(.title3)
              .foregroundStyle(.secondary)
          }
          HStack(spacing: 20) {
            if set.downloadState == "ready" {
              Button {
                model.togglePlayback(set.id)
              } label: {
                Label(isPlaying ? "Pause" : "Play here", systemImage: isPlaying ? "pause.fill" : "play.fill")
                  .orbisSymbolReplace()
              }
              .buttonStyle(.glassProminent)
              .tint(Color.orbis.tint)
              .focused($focus, equals: .play)
              .accessibilityIdentifier("person-play-now")
            }
            saveButton(set)
          }
          .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
          .frame(width: 620)
          .shadow(color: .black.opacity(0.5), radius: 36, y: 20)
          .accessibilityHidden(true)
      }
      .focusSection()
    }

    /// Save while the Set is not in the signed-in Person's Library; once it is, a quiet note.
    @ViewBuilder private func saveButton(_ set: SavedSet) -> some View {
      if model.savedSet(set.id) != nil || friend?.savedIds.contains(set.id) == true {
        Label("In Library", systemImage: "checkmark")
          .font(.callout.weight(.semibold))
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("person-save-now")
      } else {
        Button {
          Task { await friend?.save(set) }
        } label: {
          Label("Save", systemImage: "plus")
        }
        .buttonStyle(.glass)
        .accessibilityIdentifier("person-save-now")
      }
    }

    @ViewBuilder private func library(_ person: PersonFilters) -> some View {
      switch friend?.state ?? .loading {
      case .idle, .loading:
        TVPageState { TVLoading() }
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading \(person.username)’s Library") {
            Task { await friend?.load() }
          }
        }
      case .loaded(let content):
        // Each Set shows once: the one playing now leaves Played lately, and Sets played lately
        // leave the Library.
        let playingId = presence?.set.id
        let recent = content.recent.filter { $0.set.id != playingId }
        let shown = Set(recent.map(\.set.id)).union([playingId].compactMap { $0 })
        let library = content.sets.filter { !shown.contains($0.id) }
        if !recent.isEmpty {
          TVRail(title: "Played lately") {
            ForEach(recent, id: \.startedAt) { listen in
              TVFriendTile(
                model: model, set: listen.set,
                detail: SetPresentation.date(from: listen.startedAt).formatted(.relative(presentation: .named)))
            }
          }
        }
        ForEach(content.playlists) { playlist in
          if !playlist.sets.isEmpty {
            TVRail(
              title: playlist.name,
              subtitle: playlist.setCount == 1 ? "Playlist · 1 set" : "Playlist · \(playlist.setCount) sets"
            ) {
              ForEach(playlist.sets) { set in
                TVFriendTile(model: model, set: set)
              }
            }
          }
        }
        if !library.isEmpty {
          VStack(alignment: .leading, spacing: 20) {
            SectionHeading("Library")
            LazyVGrid(columns: TVLayout.columns, alignment: .leading, spacing: TVLayout.gap) {
              ForEach(library) { set in
                TVFriendTile(model: model, set: set)
              }
            }
            .focusSection()
          }
        }
        if recent.isEmpty, content.playlists.isEmpty, library.isEmpty, playingId == nil {
          TVPageState {
            ContentUnavailableView {
              Label("Nothing here yet", systemImage: "music.note.list")
            } description: {
              Text("\(person.username) hasn’t saved or played anything yet.")
            }
          }
        }
      }
    }
  }

  /// One of a friend's Sets as a tile. Pressing it plays it here when its audio is on the service;
  /// one that is not says so under its name.
  private struct TVFriendTile: View {
    @Bindable var model: AppModel
    let set: SavedSet
    var detail: String?

    var body: some View {
      let isCurrent = model.audioPlayer.currentSetId == set.id
      let isPlaying = isCurrent && model.audioPlayer.state == .playing
      let isReady = set.downloadState == "ready"
      let detail =
        isReady
        ? detail ?? set.creator ?? set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil }
        : "Not downloaded yet"
      VStack(alignment: .leading, spacing: 14) {
        Button {
          model.togglePlayback(set.id)
        } label: {
          Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .tile)
            .overlay(alignment: .bottomTrailing) {
              if isCurrent {
                EqualizerBars(isPlaying: isPlaying, color: .white)
                  .frame(height: 20)
                  .padding(12)
                  .background(.black.opacity(0.45), in: .circle)
                  .padding(12)
              }
            }
        }
        .buttonStyle(.card)
        .disabled(!isReady)
        .accessibilityLabel([set.title, detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(isCurrent ? (isPlaying ? "Playing" : "Paused") : "")
        .accessibilityHint(isReady ? "Plays this Set" : "")
        VStack(alignment: .leading, spacing: 2) {
          Text(set.title)
            .font(.title3.weight(.semibold))
            .lineLimit(2, reservesSpace: true)
            .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
          if let detail {
            Text(detail)
              .font(.body)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        .padding(.horizontal, 4)
        .accessibilityHidden(true)
      }
      .frame(width: Artwork.Size.tile.width, alignment: .leading)
    }
  }
#endif
