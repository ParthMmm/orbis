#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// The spacing the TV pages share, so a grid, a rail, and a hero line up with each other.
  @MainActor
  enum TVLayout {
    static let gap: CGFloat = 48
    static let columns = Array(repeating: GridItem(.flexible(), spacing: gap, alignment: .top), count: 4)
    /// Room above and below a rail for the focus lift, which `scrollClipDisabled` lets escape.
    static let liftInset: CGFloat = 40
  }

  func openedSet(_ model: AppModel, _ destination: Destination) -> Binding<String?> {
    Binding(
      get: { model.openedSets[destination] },
      set: { model.openedSets[destination] = $0 }
    )
  }

  struct TVLoading: View {
    var body: some View {
      ProgressView()
        .accessibilityLabel("Loading")
    }
  }

  /// Sets as focusable tiles. The Library, a Playlist page, and Search results all draw their
  /// Sets this way, so one grid decides what a Set looks like on the TV. A tile fills its column,
  /// so the grid runs edge to edge whatever the width.
  struct TVSetGrid: View {
    @Bindable var model: AppModel
    let sets: [SavedSet]
    var identifierPrefix = "tv-set"

    var body: some View {
      LazyVGrid(columns: TVLayout.columns, alignment: .leading, spacing: TVLayout.gap) {
        ForEach(sets) { set in
          TVSetTile(model: model, set: set, size: .header)
            .accessibilityIdentifier("\(identifierPrefix)-\(set.id)")
        }
      }
      .focusSection()
    }
  }

  /// A Set as a tile: its artwork is the button, lifted on focus the way the system lifts a
  /// poster, and its words sit under it where the lift leaves them be. Marked when it is the one
  /// in the player.
  struct TVSetTile: View {
    let model: AppModel
    let set: SavedSet
    var detail: String?
    var size: Artwork.Size = .tile

    var body: some View {
      let isCurrent = model.audioPlayer.currentSetId == set.id
      let isPlaying = isCurrent && model.audioPlayer.state == .playing
      let detail =
        detail ?? set.creator
        ?? set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil }
      VStack(alignment: .leading, spacing: 14) {
        Button {
          model.openSet(set.id)
        } label: {
          Artwork(
            url: SetPresentation.row(set).artwork, seed: set.title, size: size,
            progress: SetPresentation.progress(of: set)
          )
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
        .accessibilityLabel([set.title, detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(
          isCurrent ? (isPlaying ? "Playing" : "Paused") : (SetPresentation.timeLeft(set) ?? "")
        )
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
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
        // The button already says the title, so the words under it are not read a second time.
        .accessibilityHidden(true)
      }
      .frame(width: size.width, alignment: .leading)
    }
  }

  /// A row of cards that scrolls sideways, as a music app's home lays out its sections. The focus
  /// lift is not clipped, and the whole rail is one focus section so a swipe moves along it.
  struct TVRail<Cards: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder let cards: () -> Cards

    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        SectionHeading(title, subtitle: subtitle)
        ScrollView(.horizontal) {
          LazyHStack(alignment: .top, spacing: TVLayout.gap) { cards() }
            .padding(.vertical, TVLayout.liftInset)
        }
        .scrollClipDisabled()
        .focusSection()
      }
      .accessibilityElement(children: .contain)
    }
  }

  /// Tags as glass chips a swipe runs along. Pressing one is what the caller decides: a filter on
  /// the Library, or a jump to it.
  struct TVTagChips: View {
    let tags: [String]
    let counts: [String: Int]
    var selected: String?
    var identifierPrefix = "tv-tag"
    var hint: String?
    var verticalInset: CGFloat = 24
    let press: (String) -> Void

    var body: some View {
      ScrollView(.horizontal) {
        GlassEffectContainer(spacing: 20) {
          HStack(spacing: 20) {
            ForEach(tags, id: \.self) { tag in
              chip(tag)
            }
          }
        }
        .padding(.vertical, verticalInset)
      }
      .scrollClipDisabled()
      .focusSection()
    }

    /// One style per chip, varied by tint: a press must not rebuild the button the focus is on.
    private func chip(_ tag: String) -> some View {
      let category = SetPresentation.category(for: tag)
      let isSelected = tag == selected
      let count = counts[tag]
      return Button {
        press(tag)
      } label: {
        Label {
          TVChipWords(tag: tag, count: count)
        } icon: {
          Circle().fill(category.dot).frame(width: 12, height: 12)
        }
      }
      .buttonStyle(.glass)
      .tint(isSelected ? category.dot : category.dot.opacity(0.35))
      .accessibilityLabel(count.map { "\(tag), \($0 == 1 ? "1 set" : "\($0) sets")" } ?? tag)
      .accessibilityHint(hint ?? "")
      .accessibilityAddTraits(isSelected ? .isSelected : [])
      .accessibilityIdentifier("\(identifierPrefix)-\(tag)")
    }
  }

  /// A chip's words. The glass style writes them in the tint, which is too faint on dark glass,
  /// so unfocused they take the primary colour; focused, the system's light pill chooses.
  private struct TVChipWords: View {
    let tag: String
    let count: Int?
    @Environment(\.isFocused) private var isFocused

    var body: some View {
      let words = HStack(spacing: 8) {
        Text(tag)
        if let count {
          Text(count, format: .number).monospacedDigit().opacity(0.7)
        }
      }
      // `Color.primary`, not `.primary`: the hierarchical style would be a level of the tint
      // the glass style hands down, which is the faint text being fixed.
      if isFocused {
        words
      } else {
        words.foregroundStyle(Color.primary)
      }
    }
  }

  /// A state the TV pages show in the space a grid would take.
  struct TVPageState<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
      content()
        .frame(maxWidth: .infinity, minHeight: 600)
    }
  }

  /// The Library: the Tags to filter by, then every Set as a tile, in the order the person chose
  /// on their other devices.
  struct TVLibrary: View {
    @Bindable var model: AppModel

    private var sets: Loadable<[SavedSet]> {
      guard case .loaded(let loaded) = model.visibleSets else { return model.visibleSets }
      return .loaded(model.librarySort.ordered(loaded))
    }

    private var lead: SavedSet? {
      guard case .loaded(let loaded) = sets else { return nil }
      return loaded.first
    }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 32) {
          if !model.availableTags.isEmpty {
            TVTagChips(
              tags: model.availableTags, counts: model.tagCounts, selected: model.activeTags.first,
              hint: "Filters the library"
            ) { tag in
              model.setTagFilter(model.activeTags == [tag] ? nil : tag)
            }
          }
          if let creator = model.activeCreator {
            Button {
              model.activeCreator = nil
            } label: {
              Label(creator.name, systemImage: "xmark.circle.fill")
            }
            .buttonStyle(.glass)
            .accessibilityLabel("Showing sets by \(creator.name). Clear.")
            .accessibilityIdentifier("creator-filter")
          }
          content
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background { ArtworkGlow(url: lead.flatMap(SetPresentation.pageArtwork), reach: 0.75) }
      .navigationDestination(item: openedSet(model, .library)) { id in
        TVSetPage(model: model, setId: id).id(id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-library")
    }

    @ViewBuilder private var content: some View {
      switch sets {
      case .idle, .loading:
        TVPageState { TVLoading() }
          .accessibilityIdentifier("library-loading")
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading the library") {
            Task { await model.loadLibrary() }
          }
        }
        .accessibilityIdentifier("library-error")
      case .loaded(let loaded):
        if loaded.isEmpty, model.isFilteringLibrary {
          TVPageState {
            NoResultsState(recoverLabel: "Clear filters") { model.clearLibraryFilters() }
          }
          .accessibilityIdentifier("library-no-matches")
        } else if loaded.isEmpty {
          TVPageState { TVEmptyLibrary() }
            .accessibilityIdentifier("library-empty")
        } else {
          TVSetGrid(model: model, sets: loaded)
        }
      }
    }
  }

  /// A Library with nothing in it yet.
  struct TVEmptyLibrary: View {
    var body: some View {
      ContentUnavailableView {
        Label("Nothing filed yet", systemImage: "music.note.list")
      } description: {
        Text("File a set from Orbis on your iPhone or Mac, and it appears here.")
      }
    }
  }

  /// Every Playlist as a folder; pressing one opens its page.
  struct TVPlaylists: View {
    @Bindable var model: AppModel

    private var librarySets: [SavedSet] {
      if case .loaded(let sets) = model.library { sets } else { [] }
    }

    private func artwork(of playlist: Playlist) -> [URL?] {
      librarySets.filter { $0.playlistIds.contains(playlist.id) }
        .prefix(3).map { SetPresentation.row($0).artwork }
    }

    /// Popping the page with Menu closes the Playlist the way the phone's back button does, so
    /// its members and any failure do not wait for the next one.
    private var openedPlaylist: Binding<String?> {
      Binding(
        get: { model.openedPlaylistId },
        set: { id in
          if id == nil { model.closePlaylist() } else { model.openedPlaylistId = id }
        })
    }

    var body: some View {
      ScrollView {
        content
          .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(
          url: model.playlistItems.first.flatMap { artwork(of: $0).first ?? nil }, reach: 0.55)
      }
      .navigationDestination(item: openedPlaylist) { id in
        TVPlaylistPage(model: model, playlistId: id).id(id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-playlists")
    }

    @ViewBuilder private var content: some View {
      switch model.playlists {
      case .idle, .loading:
        TVPageState { TVLoading() }
          .accessibilityIdentifier("playlists-loading")
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading playlists") {
            Task { await model.loadPlaylists() }
          }
        }
        .accessibilityIdentifier("playlists-error")
      case .loaded(let items):
        if items.isEmpty {
          TVPageState {
            ContentUnavailableView {
              Label("No playlists yet", systemImage: "rectangle.stack")
            } description: {
              Text("Make one from Orbis on your iPhone or Mac, and it appears here.")
            }
          }
          .accessibilityIdentifier("playlists-empty")
        } else {
          LazyVGrid(columns: TVLayout.columns, alignment: .leading, spacing: TVLayout.gap) {
            ForEach(items) { playlist in
              Button {
                model.openPlaylist(playlist.id)
              } label: {
                PlaylistSleeve(
                  name: playlist.name,
                  count: playlist.setCount,
                  artwork: artwork(of: playlist),
                  category: SetPresentation.category(for: playlist.name),
                  fanWidth: 260, height: 330
                )
              }
              .buttonStyle(.card)
              .accessibilityIdentifier("tv-playlist-\(playlist.id)")
            }
          }
          .focusSection()
        }
      }
    }
  }

  /// One Playlist: its Sets fanned out large, the two ways to play it, then its Sets as tiles.
  /// The page reads the Playlist from the model on every pass, so a reload never blanks it.
  struct TVPlaylistPage: View {
    @Bindable var model: AppModel
    let playlistId: String
    @FocusState private var focus: Focus?
    @State private var pendingPlay: PlayOrder?

    private enum Focus {
      case play
    }

    private enum PlayOrder {
      case inOrder
      case shuffled
    }

    private var members: [SavedSet] {
      if case .loaded(let sets) = model.playlistMembers { sets } else { [] }
    }

    var body: some View {
      Group {
        if let playlist = model.playlist(playlistId) {
          page(playlist)
        } else if case .loaded = model.playlists {
          ContentUnavailableView {
            Label("This playlist is gone", systemImage: "questionmark.folder")
          } description: {
            Text("It was removed from your library.")
          }
          .accessibilityIdentifier("playlist-missing")
        } else {
          TVLoading()
        }
      }
      .task(id: playlistId) { await model.loadPlaylistMembers(playlistId) }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-playlist-page")
    }

    private func page(_ playlist: Playlist) -> some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 40) {
          hero(playlist)
          content
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(url: members.first.map { SetPresentation.row($0).artwork } ?? nil, reach: 0.6)
      }
      .defaultFocus($focus, .play)
      .confirmationDialog(
        "Play this playlist?", isPresented: isConfirmingPlay, titleVisibility: .visible
      ) {
        Button("Replace the queue") { startPlayback() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now.")
      }
      .navigationDestination(item: openedSet(model, .playlists)) { id in
        TVSetPage(model: model, setId: id).id(id)
      }
    }

    private func hero(_ playlist: Playlist) -> some View {
      let seconds = members.compactMap(\.durationSeconds).reduce(0, +)
      let count = members.count == 1 ? "1 set" : "\(members.count) sets"
      return HStack(alignment: .center, spacing: 64) {
        SleeveFan(
          seed: playlist.name,
          artwork: members.prefix(3).map { SetPresentation.row($0).artwork },
          category: SetPresentation.category(for: playlist.name),
          width: 400
        )
        .frame(width: 600, height: 340)
        VStack(alignment: .leading, spacing: 20) {
          Eyebrow("Playlist")
          Text(playlist.name)
            .font(.orbis.largeTitle)
            .lineLimit(2)
            .accessibilityAddTraits(.isHeader)
          Text(seconds > 0 ? "\(count) · \(SetPresentation.length(seconds))" : count)
            .font(.title3)
            .foregroundStyle(.secondary)
          HStack(spacing: 20) {
            Button {
              play(shuffled: false)
            } label: {
              Label("Play", systemImage: "play.fill")
            }
            .buttonStyle(.glassProminent)
            .tint(Color.orbis.tint)
            .focused($focus, equals: .play)
            .accessibilityIdentifier("playlist-play")
            Button {
              play(shuffled: true)
            } label: {
              Label("Shuffle", systemImage: "shuffle")
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("playlist-shuffle")
          }
          .disabled(members.isEmpty)
          .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .focusSection()
    }

    @ViewBuilder private var content: some View {
      switch model.playlistMembers {
      case .idle, .loading:
        TVPageState { TVLoading() }
          .accessibilityIdentifier("playlist-members-loading")
      case .failed(let failure):
        TVPageState {
          UnavailableState(failure: failure, context: "loading this playlist") {
            Task { await model.loadPlaylistMembers(playlistId) }
          }
        }
        .accessibilityIdentifier("playlist-members-error")
      case .loaded(let sets):
        if sets.isEmpty {
          TVPageState {
            ContentUnavailableView {
              Label("This Playlist is empty", systemImage: "rectangle.stack")
            } description: {
              Text("Add Sets to it from Orbis on your iPhone or Mac.")
            }
          }
          .accessibilityIdentifier("playlist-empty")
        } else {
          TVSetGrid(model: model, sets: sets, identifierPrefix: "playlist-member")
            .accessibilityIdentifier("playlist-members")
        }
      }
    }

    private var isConfirmingPlay: Binding<Bool> {
      Binding(get: { pendingPlay != nil }, set: { if !$0 { pendingPlay = nil } })
    }

    private func play(shuffled: Bool) {
      pendingPlay = shuffled ? .shuffled : .inOrder
      if !model.isPlayingNow { startPlayback() }
    }

    private func startPlayback() {
      let order = pendingPlay
      pendingPlay = nil
      Task {
        if order == .shuffled {
          await model.shufflePlaylist(playlistId)
        } else {
          await model.playPlaylist(playlistId)
        }
      }
    }
  }

  /// Search: before a query, the Tags and creators to browse by; after one, the Sets found and the
  /// tracks found inside Tracklists.
  struct TVSearch: View {
    @Bindable var model: AppModel

    private static let cueLimit = 8

    private var isUntouched: Bool {
      if case .idle = model.search { return true }
      return false
    }

    /// One Set per creator, the newest.
    private var creators: [SavedSet] {
      guard case .loaded(let sets) = model.library else { return [] }
      var seen = Set<String>()
      return sets.filter { set in
        guard let name = set.creator, !name.isEmpty else { return false }
        return seen.insert(name).inserted
      }
      .prefix(12)
      .map { $0 }
    }

    private var topResult: SavedSet? {
      if case .loaded(let sets) = model.search { sets.first } else { nil }
    }

    var body: some View {
      ScrollView {
        Group {
          if isUntouched {
            start
          } else {
            results
          }
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(url: topResult.flatMap(SetPresentation.pageArtwork), reach: 0.55)
      }
      .searchable(text: $model.searchQuery, prompt: "Title, tag, or source link")
      .searchesAsTyped(model)
      .task { await model.loadTracklistsForSearch() }
      .navigationDestination(item: openedSet(model, .search)) { id in
        TVSetPage(model: model, setId: id).id(id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-search")
    }

    private var start: some View {
      VStack(alignment: .leading, spacing: 32) {
        ListingLabel(
          model.totalCount == 1 ? "Search your 1 set." : "Search your \(model.totalCount) sets.")
        if !model.availableTags.isEmpty {
          SectionHeading("Tags")
          TVTagChips(
            tags: model.availableTags, counts: model.tagCounts, identifierPrefix: "search-tag",
            hint: "Shows the library filtered by this tag"
          ) { tag in
            model.setTagFilter(tag)
            model.openedSets[.library] = nil
            model.destination = .library
          }
        }
        if !creators.isEmpty {
          TVRail(title: "Creators") {
            ForEach(creators) { set in
              Button {
                model.showCreator(of: set)
              } label: {
                VStack(spacing: 16) {
                  Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .header)
                    .frame(width: 360)
                    .frame(width: 200, height: 200)
                    .clipShape(.circle)
                  Text(set.creator ?? "")
                    .font(.title3.weight(.medium))
                    .lineLimit(1)
                    .frame(width: 220)
                }
              }
              .buttonStyle(.card)
              .accessibilityLabel("Sets by \(set.creator ?? "")")
            }
          }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("search-untouched")
    }

    @ViewBuilder private var results: some View {
      let query = model.searchResultsFor ?? ""
      let cues = model.cueMatches(for: query)
      VStack(alignment: .leading, spacing: 32) {
        Text(query.isEmpty ? "Search" : "Results for \"\(query)\"")
          .font(.orbis.sectionTitle)
          .accessibilityAddTraits(.isHeader)
        switch model.search {
        case .idle, .loading:
          TVPageState { TVLoading() }
        case .failed(let failure):
          TVPageState {
            UnavailableState(failure: failure, context: "searching the library") {
              Task { await model.runSearch() }
            }
          }
        case .loaded(let sets):
          if sets.isEmpty, cues.isEmpty {
            TVPageState {
              NoResultsState(recoverLabel: "Clear search") { model.clearSearch() }
            }
            .accessibilityIdentifier("search-no-results")
          } else {
            if !sets.isEmpty {
              TVSetGrid(model: model, sets: sets, identifierPrefix: "search-result")
                .accessibilityIdentifier("search-list")
            }
            if !cues.isEmpty {
              SectionHeading("In tracklists")
              LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(cues.prefix(Self.cueLimit)) { match in
                  cueRow(match)
                }
              }
              .focusSection()
            }
          }
        }
      }
    }

    /// A track found inside a Tracklist.
    private func cueRow(_ match: CueMatch) -> some View {
      Button {
        Task { await model.playCue(match.cue, in: match.set.id) }
      } label: {
        HStack(spacing: 24) {
          Image(systemName: "music.note")
            .font(.title3.weight(.semibold))
            .foregroundStyle(Color.orbis.tint)
            .frame(width: 56, height: 56)
            .background(Color.orbis.tint.opacity(0.12), in: .circle)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(match.cue.title)
              .font(.title3.weight(.semibold))
            Text("\(match.cue.artist) · in \(match.set.title)")
              .font(.body)
              .foregroundStyle(.secondary)
          }
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          if let start = match.cue.startSeconds {
            Text(SetPresentation.timestamp(start))
              .font(.body)
              .monospacedDigit()
              .foregroundStyle(.secondary)
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
      .buttonStyle(.card)
      .disabled(match.cue.startSeconds == nil || match.set.downloadState != "ready")
      .accessibilityLabel("\(match.cue.title), \(match.cue.artist), in \(match.set.title)")
      .accessibilityValue(match.cue.startSeconds.map { "starts at \(SetPresentation.spoken($0))" } ?? "")
      .accessibilityHint("Plays the set from this track")
      .accessibilityIdentifier("search-cue-\(match.id)")
    }
  }
#endif
