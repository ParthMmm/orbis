import OrbisDesign
import SwiftUI

#if os(iOS)
  /// iPhone. Library is a tab; Search takes the search role, so the system draws it as the
  /// separate button beside the tab bar and opens the field in its place. Now playing rides the
  /// tab bar as its bottom accessory, the way a music app carries it, and the bar recedes as the
  /// list scrolls.
  struct CompactShell: View {
    @Bindable var model: AppModel

    /// A tap on the Search tab while Search is open asks for the field, rather than doing nothing.
    private var tabSelection: Binding<Destination> {
      Binding(
        get: { model.destination },
        set: { next in
          if next == .search, model.destination == .search { model.searchFocusRequests += 1 }
          model.destination = next
        })
    }
    /// Now Playing is a sheet over the whole shell, so it opens the same from any tab.
    @State private var isNowPlayingShown = false
    /// Now Playing grows out of the mini player's artwork and shrinks back into it.
    @Namespace private var nowPlaying

    var body: some View {
      TabView(selection: tabSelection) {
        // Search is a tab like the others, as in Apple Music. The search role would split it
        // off into a circle that turns into a field, and the field belongs at the top of Search.
        ForEach([Destination.home, .library, .playlists, .people, .search]) { destination in
          Tab(destination.rawValue, systemImage: destination.symbol, value: destination) {
            NavigationStack {
              DestinationView(model: model, destination: destination)
            }
          }
        }
      }
      .tabBarMinimizeBehavior(.onScrollDown)
      // `isEnabled` is why the target is iOS 26.1: 26.0 reserves an empty pill for an empty
      // accessory, and the only way round it there is to rebuild the tab view.
      .tabViewBottomAccessory(isEnabled: model.showsMiniPlayer) {
        NowPlayingBar(model: model, transition: nowPlaying) { isNowPlayingShown = true }
      }
      .nowPlayingCover(isPresented: $isNowPlayingShown) {
        NowPlayingScreen(model: model)
          .zoomsFromMiniPlayer(nowPlaying)
      }
    }
  }

#endif

/// iPad and macOS. The same destinations become sidebar items. A plain list with explicit
/// selection buttons is used because SwiftUI's selection-based `List` initializers are
/// unavailable on iOS.
struct SidebarShell: View {
  @Bindable var model: AppModel

  #if os(macOS)
    private enum Selection: Hashable {
      case destination(Destination)
      case playlist(String)
    }

    private var selection: Binding<Selection?> {
      Binding(
        get: {
          if model.destination == .playlists, let id = model.openedPlaylistId {
            return .playlist(id)
          }
          return .destination(model.destination)
        },
        set: { selected in
          guard let selected else { return }
          switch selected {
          case .destination(let destination):
            // Choosing Search again asks for its field, as a second tap on the tab does.
            if destination == .search { model.searchFocusRequests += 1 }
            // Playlists in the sidebar is the grid of folders, not the last one opened.
            if destination == .playlists { model.closePlaylist() }
            model.destination = destination
          case .playlist(let id):
            model.showPlaylist(id)
          }
        }
      )
    }

    /// A heading over nothing reads as a list that failed to load, so the section waits for a
    /// Playlist, or for the failure it has to explain.
    private var showsPlaylistsSection: Bool {
      if case .failed = model.playlists { return true }
      return !model.playlistItems.isEmpty
    }
  #else
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
  #endif
  @State private var isNowPlayingShown = false
  @Namespace private var nowPlaying

  var body: some View {
    #if os(macOS)
      let visibility: Binding<NavigationSplitViewVisibility> = .constant(.all)
    #else
      let visibility = $columnVisibility
    #endif
    NavigationSplitView(columnVisibility: visibility) {
      #if os(macOS)
        List(selection: selection) {
          Label("Search", systemImage: "magnifyingglass")
            .tag(Selection.destination(.search))
            .accessibilityIdentifier("sidebar-search")
          ForEach(Destination.shellCases) { destination in
            Label(destination.rawValue, systemImage: destination.symbol)
              .tag(Selection.destination(destination))
              .accessibilityIdentifier("sidebar-\(destination.rawValue.lowercased())")
          }
          if showsPlaylistsSection {
            Section("Playlists") {
              ForEach(model.playlistItems) { playlist in
                PlaylistRow(
                  playlist.name,
                  count: playlist.setCount,
                  category: SetPresentation.category(for: playlist.name)
                )
                .tag(Selection.playlist(playlist.id))
                .accessibilityIdentifier("playlist-\(playlist.name)")
              }
              if case .failed(let failure) = model.playlists {
                playlistsErrorRow(failure)
              }
            }
          }
        }
        .listStyle(.sidebar)
        .environment(\.defaultMinListRowHeight, 32)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 340)
        .navigationTitle("")
        .safeAreaBar(edge: .bottom) {
          SettingsLink { Label("Settings", systemImage: "gearshape") }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .accessibilityIdentifier("sidebar-settings")
        }
        .accessibilityIdentifier("sidebar")
      #else
        List {
          ForEach(Destination.shellCases) { destination in
            Button {
              model.destination = destination
            } label: {
              HStack(spacing: 8) {
                Label(destination.rawValue, systemImage: destination.symbol)
                Spacer(minLength: 0)
                // The tint alone says nothing to a person who cannot see it, so the row is marked.
                if model.destination == destination {
                  Image(systemName: "checkmark")
                    .font(.orbis.caption)
                    .foregroundStyle(.secondary)
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(model.destination == destination ? [.isSelected] : [])
            .listRowBackground(
              model.destination == destination
                ? Color.accentColor.opacity(0.18)
                : Color.clear
            )
            .accessibilityIdentifier("sidebar-\(destination.rawValue.lowercased())")
          }
          Section("Playlists") {
            ForEach(model.playlistItems) { playlist in
              playlistRow(playlist.id, name: playlist.name, count: playlist.setCount)
            }
            if case .failed(let failure) = model.playlists {
              playlistsErrorRow(failure)
            }
          }
        }
        .navigationTitle("Orbis")
        .accessibilityIdentifier("sidebar")
      #endif
    } detail: {
      NavigationStack {
        DestinationView(model: model, destination: model.destination)
      }
      .safeAreaInset(edge: .bottom) {
        if model.showsMiniPlayer {
          NowPlayingBar(model: model, surface: .floating, transition: nowPlaying) {
            isNowPlayingShown = true
          }
          .frame(maxWidth: 560)
          .padding()
        }
      }
    }
    .nowPlayingCover(isPresented: $isNowPlayingShown) {
      NowPlayingScreen(model: model)
        .zoomsFromMiniPlayer(nowPlaying)
        #if os(macOS)
          // As large as the window allows: the player and its Tracklist sit side by side.
          .frame(minWidth: 900, idealWidth: 1100, minHeight: 640, idealHeight: 760)
        #endif
    }
    #if os(macOS)
      .toolbar(removing: .sidebarToggle)
      .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
    #endif
  }

  /// A playlist section that failed to load must say so, because an empty section reads
  /// as "no playlists" and invites relaunching the app instead of trying again here.
  private func playlistsErrorRow(_ failure: OrbisFailure) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(failure.message)
        .font(.orbis.caption)
        .foregroundStyle(.secondary)
      Button("Try again") { Task { await model.loadPlaylists() } }
        .buttonStyle(.plain)
        .foregroundStyle(Color.orbis.tint)
        .accessibilityIdentifier("playlists-retry")
    }
    .accessibilityIdentifier("playlists-error")
  }

  /// A playlist in the sidebar opens its own page, with Play and Shuffle, the same page a
  /// folder on the Playlists tab opens.
  private func playlistRow(_ id: String, name: String, count: Int) -> some View {
    let isOpen = model.destination == .playlists && model.openedPlaylistId == id
    return Button {
      model.showPlaylist(id)
    } label: {
      PlaylistRow(
        name,
        count: count,
        category: SetPresentation.category(for: name),
        isSelected: isOpen
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isOpen ? [.isSelected] : [])
    .listRowBackground(isOpen ? Color.accentColor.opacity(0.18) : Color.clear)
    .accessibilityIdentifier("playlist-\(name)")
  }
}

struct DestinationView: View {
  @Bindable var model: AppModel
  let destination: Destination
  /// Replacing the queue is worth a question only while something is playing.
  @State private var isConfirmingPlaylist = false
  /// The empty Library's action asks the paste field to take focus.
  @State private var focusLink = false
  /// Filing happens in a sheet from the toolbar's +, and the naming step follows in the same
  /// sheet, so the Library itself is the collection and nothing else.
  @State private var isFilingSheetShown = false

  @State private var libraryQuery = ""
  /// The Set whose Tags are open for editing from its row's menu.
  @State private var taggingSet: SavedSet?
  /// The Sets picked in the Library's selection mode, or nil when it is not selecting.
  @State private var selectedIds: Set<String>?
  @State private var isBulkTagging = false

  #if os(macOS)
    private var matchingLibrary: Loadable<[SavedSet]> {
      guard case .loaded(let sets) = model.visibleSets,
        !libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { return model.visibleSets }
      return .loaded(
        sets.filter { set in
          set.title.localizedCaseInsensitiveContains(libraryQuery)
            || (set.creator?.localizedCaseInsensitiveContains(libraryQuery) ?? false)
            || set.tags.contains { $0.localizedCaseInsensitiveContains(libraryQuery) }
        })
    }
  #endif

  var body: some View {
    switch destination {
    case .home:
      home
    case .library:
      SetList(
        state: librarySets,
        heading: libraryHeading,
        empty: AnyView(
          EmptyLibraryState(recover: { openFilingSheet() })
            .accessibilityIdentifier("library-empty")
        ),
        failureContext: "loading the library",
        hiddenTags: model.activeTags,
        filters: clearFilters,
        // Only a filter can hide every Set. Without one, an empty list is an empty collection
        // and keeps the empty collection's copy.
        noMatches: librarySearchIsActive
          ? AnyView(
            NoResultsState(recoverLabel: "Clear search", recover: { libraryQuery = "" })
              .accessibilityIdentifier("library-no-matches")
          )
          : !model.isFilteringLibrary
            ? nil
            : AnyView(
              NoResultsState(recoverLabel: "Clear filters", recover: { model.clearLibraryFilters() })
                .accessibilityIdentifier("library-no-matches")
            ),
        hero: MacPageTitle.slot("Library"),
        rails: (model.availableTags.isEmpty && model.activeCreator == nil) || librarySearchIsActive
          ? nil : tagTiles,
        footer: librarySearchIsActive ? "\(libraryMatchCount) sets" : libraryFooter,
        retry: { await model.loadLibrary() },
        select: { set in model.openSet(set.id) },
        currentSetId: model.audioPlayer.currentSetId,
        isPlaying: model.audioPlayer.state == .playing,
        togglePlayback: { set in model.togglePlayback(set.id) },
        groupsByDay: model.librarySort == .newest,
        menuTags: model.availableTags,
        toggleTag: { set, tag in
          Task { await model.setTag(tag, on: [set.id], to: !set.tags.contains(tag)) }
        },
        editTags: { taggingSet = $0 },
        selection: selectedIds,
        toggleSelection: { set in
          selectedIds = selectedIds.map { $0.symmetricDifference([set.id]) }
        },
        backdrop: .artwork(libraryLead.flatMap(SetPresentation.pageArtwork))
      )
      .refreshable { await model.refreshLibraryQuietly() }
      // A row's menu and the selection bar change Sets from here, so their refusals show here.
      .setChangeStatus(model)
      .macPageSearch(text: $libraryQuery, prompt: "Find in Library")
      .macSearchToolbarBackground(isSearching: librarySearchIsActive)
      .sidebarPageTitle("Library")
      // Pinned rather than left to the default, so the large title stays large whatever the
      // tab's content state is; the Set page pins its inline counterpart the same way. A Mac
      // has no large title to pin.
      .largeTitleOnIOS()
      .toolbar { libraryToolbar }
      .sheet(isPresented: $isFilingSheetShown) { filingSheet }
      .onChange(of: model.reveal != nil) { _, hasReveal in
        if hasReveal { isFilingSheetShown = true }
      }
      .safeAreaInset(edge: .bottom) {
        if let selectedIds { selectionBar(count: selectedIds.count) }
      }
      .sheet(isPresented: $isBulkTagging) {
        BulkTagSheet(model: model, ids: Array(selectedIds ?? []))
      }
      .sheet(item: $taggingSet) { set in
        TagSheet(tags: set.tags, suggestions: model.availableTags) { tags in
          Task { await model.replaceTags(set.id, with: tags) }
        }
      }
      .confirmationDialog(
        "Play this playlist?", isPresented: $isConfirmingPlaylist, titleVisibility: .visible
      ) {
        Button("Replace the queue") { playSelectedPlaylist() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This replaces what is playing now and starts the first set in the playlist.")
      }
      .navigationDestination(item: openedSet) { id in
        SetDetailScreen(model: model, setId: id)
      }
    case .playlists:
      PlaylistsDestination(model: model)
        .navigationDestination(item: openedSet) { id in
          SetDetailScreen(model: model, setId: id)
        }
    case .people:
      PeopleDestination(model: model)
    case .search:
      SearchDestination(model: model)
        // The one open Set is shared with the Library, so a Set found here opens the same page.
        .navigationDestination(item: openedSet) { id in
          SetDetailScreen(model: model, setId: id)
        }
    }
  }

  /// The large title already says Library, so the list carries no heading of its own; the
  /// active filter is underlined in the ledger row instead.
  private var libraryHeading: Text? { nil }

  private var librarySets: Loadable<[SavedSet]> {
    #if os(macOS)
      let sets = matchingLibrary
    #else
      let sets = model.visibleSets
    #endif
    guard case .loaded(let loaded) = sets else { return sets }
    return .loaded(model.librarySort.ordered(loaded))
  }

  /// The Set at the top of the Library as it is ordered and filtered now, which the page takes
  /// its light from, so filtering by a Tag recolours the page.
  private var libraryLead: SavedSet? {
    guard case .loaded(let sets) = librarySets else { return nil }
    return sets.first
  }

  private var librarySearchIsActive: Bool {
    #if os(macOS)
      !libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    #else
      false
    #endif
  }

  private var libraryMatchCount: Int {
    guard case .loaded(let sets) = librarySets else { return 0 }
    return sets.count
  }

  /// Home: what is new and where to go, in rails, with a waiting link above them. The full
  /// collection is the Library tab.
  private var home: some View {
    let rails = HomeRails(model: model)
    return ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        MacPageTitle.slot("Home")
        rails
      }
      .padding(.horizontal)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .background {
      ArtworkGlow(url: rails.lead.flatMap(SetPresentation.pageArtwork), reach: 0.75)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
    .overlay {
      // Before the first Set, Home has no rails to show; it says so and offers the first filing.
      if case .loaded(let sets) = model.library, sets.isEmpty {
        EmptyLibraryState(recover: { openFilingSheet() })
          .accessibilityIdentifier("home-empty")
      }
    }
    .sidebarPageTitle("Home")
    .largeTitleOnIOS()
    .toolbar {
      ToolbarItem {
        Button("File a set", systemImage: "plus") { openFilingSheet() }
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("home-file")
      }
      #if os(iOS)
        settingsButton
      #endif
    }
    .sheet(isPresented: $isFilingSheetShown) { filingSheet }
    .onChange(of: model.reveal != nil) { _, hasReveal in
      if hasReveal { isFilingSheetShown = true }
    }
    .navigationDestination(item: openedSet) { id in
      SetDetailScreen(model: model, setId: id)
    }
  }

  private var openedSet: Binding<String?> {
    Binding(
      get: { model.openedSets[destination] },
      set: { model.openedSets[destination] = $0 }
    )
  }

  private var filedSets: [SavedSet] {
    if case .loaded(let sets) = model.library { sets } else { [] }
  }

  private func openFilingSheet() {
    isFilingSheetShown = true
    #if os(iOS)
      Task {
        if model.reveal == nil, !model.isFiling, let link = await ClipboardLink.read(),
          !ClipboardLink.isFiled(link, in: filedSets)
        {
          await model.pasteAndFile(link)
        } else {
          focusLink = true
        }
      }
    #else
      focusLink = true
    #endif
  }

  private var tagTiles: AnyView {
    AnyView(
      VStack(alignment: .leading, spacing: 10) {
        if let creator = model.activeCreator {
          Button {
            model.activeCreator = nil
          } label: {
            Label(creator.name, systemImage: "xmark.circle.fill")
              .font(.orbis.detail)
          }
          .buttonStyle(.bordered)
          .tint(Color.orbis.tint)
          .accessibilityLabel("Showing sets by \(creator.name). Clear.")
          .accessibilityIdentifier("creator-filter")
        }
        ScrollView(.horizontal, showsIndicators: false) {
          GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
              ForEach(model.availableTags, id: \.self) { tag in
                let active = model.activeTags.contains(tag)
                Button {
                  model.toggleTagFilter(tag)
                } label: {
                  GlassTagChip(
                    tag, count: model.tagCounts[tag] ?? 0,
                    category: SetPresentation.category(for: tag), selected: active)
                }
                .buttonStyle(.plain)
                .orbisAnimation(.tagToggled, value: active)
                .accessibilityIdentifier("tag-filter-\(tag)")
              }
            }
            .padding(.horizontal, 16)
          }
        }
        .padding(.horizontal, -16)
        .scrollClipDisabled()
      }
    )
  }

  /// The count, and while a filter is on, what the filter is, so a short list explains itself.
  private var libraryFooter: String {
    guard model.isFilteringLibrary else {
      let total = model.totalCount
      return total == 1 ? "1 set" : "\(total) sets"
    }
    var parts = [model.visibleCount == 1 ? "1 set" : "\(model.visibleCount) sets"]
    if !model.activeTags.isEmpty {
      parts.append("tagged \(model.activeTags.formatted(.list(type: .and)))")
    }
    if let creator = model.activeCreator { parts.append("by \(creator.name)") }
    return parts.joined(separator: " ")
  }

  private func selectionBar(count: Int) -> some View {
    HStack {
      Text("\(count) selected")
        .font(.headline)
        .monospacedDigit()
        .contentTransition(.numericText())
        .accessibilityIdentifier("library-selection-count")
      Spacer()
      Button("Tag", systemImage: "tag") { isBulkTagging = true }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .disabled(count == 0)
        .accessibilityIdentifier("library-bulk-tag")
    }
    .padding(.leading, 20)
    .padding(.trailing, 8)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: .capsule)
    .padding(.horizontal)
    .padding(.bottom, 8)
  }

  private var clearFilters: AnyView? {
    guard model.isFilteringLibrary, !librarySearchIsActive else { return nil }
    return AnyView(
      Button("Clear") { model.clearLibraryFilters() }
        .font(.orbis.label)
        .foregroundStyle(Color.orbis.tint)
        .buttonStyle(.plain)
        .accessibilityLabel("Clear filters")
        .accessibilityIdentifier("library-clear-filters")
    )
  }

  private var filingSheet: some View {
    FilingSheet(model: model, focusLink: $focusLink) { isFilingSheetShown = false }
  }

  /// Selection mode shows only Done, so nothing else starts while Sets are picked.
  @ToolbarContentBuilder
  private var libraryToolbar: some ToolbarContent {
    if selectedIds == nil {
      ToolbarItem {
        Button("File a set", systemImage: "plus") { openFilingSheet() }
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("library-file")
      }
      ToolbarItem {
        Menu {
          // Playing a Playlist is only offered while the Library is showing one: with
          // Everything selected there is no Playlist to play.
          if model.selectedPlaylistId != nil {
            Button("Play playlist", systemImage: "play.circle") {
              if model.isPlayingNow {
                isConfirmingPlaylist = true
              } else {
                playSelectedPlaylist()
              }
            }
            .accessibilityIdentifier("library-play-playlist")
          }
          Button("Select", systemImage: "checkmark.circle") { selectedIds = [] }
            .accessibilityIdentifier("library-select")
          Menu("Sort by", systemImage: "arrow.up.arrow.down") {
            Picker("Sort by", selection: $model.librarySort) {
              ForEach(LibrarySort.allCases) { sort in
                Text(sort.rawValue).tag(sort)
              }
            }
          }
          .accessibilityIdentifier("library-sort")
        } label: {
          Label("More", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("library-more")
      }
    } else {
      ToolbarItem {
        Button("Done") { selectedIds = nil }
          .fontWeight(.semibold)
          .accessibilityIdentifier("library-select-done")
      }
    }
  }

  private func playSelectedPlaylist() {
    guard let playlistId = model.selectedPlaylistId else { return }
    Task { await model.playPlaylist(playlistId) }
  }

  @ToolbarContentBuilder
  private var settingsButton: some ToolbarContent {
    ToolbarItem {
      Button("Settings", systemImage: "gearshape") { model.isShowingSettings = true }
        .accessibilityIdentifier("settings-open")
    }
  }
}

/// Home: the Set to go back to, then the rails a music app's home gives its sections. The page
/// takes its light from the lead Set's artwork, so the glass on it has colour to bend.
struct HomeRails: View {
  @Bindable var model: AppModel

  /// The page's own padding, matched so a rail's first card lines up with the list under it.
  private static let edgeInset: CGFloat = 16

  var body: some View {
    VStack(alignment: .leading, spacing: 36) {
      ClipboardBanner(model: model)
      if let lead = home.lead {
        HomeHero(model: model, set: lead, isResume: home.isResume)
      }
      if !model.availableTags.isEmpty {
        tagRow
      }
      if !home.continueRail.isEmpty {
        rail("Continue listening", subtitle: "Pick up where you left off.") { continueCards }
      }
      if !home.recentlyFiled.isEmpty {
        rail("Recently filed", subtitle: "The newest links in your library.") { recentCards }
      }
      if !model.playlistItems.isEmpty {
        playlistGrid
      }
    }
    // Full width even with nothing in it. A new Person's Home is empty, and an empty column
    // narrowed the page to its padding, which drew the glow as a strip down the middle.
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The Set Home leads with: the one most recently left part-way, or else the newest filed.
  var lead: SavedSet? { home.lead }

  private var librarySets: [SavedSet] {
    if case .loaded(let sets) = model.library { sets } else { [] }
  }

  private var home: HomeSelection {
    guard case .loaded(let visible) = model.visibleSets else {
      return HomeSelection(library: librarySets, visible: [])
    }
    return HomeSelection(library: librarySets, visible: visible)
  }

  private func card(_ set: SavedSet, detail: String?) -> SetCard {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    return SetCard(
      title: set.title,
      detail: detail,
      artwork: SetPresentation.row(set).artwork,
      progress: SetPresentation.progress(of: set),
      isCurrent: isCurrent,
      isPlaying: isCurrent && model.audioPlayer.state == .playing
    )
  }

  private var continueCards: some View {
    ForEach(home.continueRail) { set in
      Button {
        model.openSet(set.id)
      } label: {
        card(set, detail: SetPresentation.timeLeft(set))
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("continue-card-\(set.id)")
    }
  }

  private var recentCards: some View {
    ForEach(home.recentlyFiled) { set in
      Button {
        model.openSet(set.id)
      } label: {
        card(
          set,
          detail: set.creator ?? set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil })
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("recent-card-\(set.id)")
    }
  }

  /// Tags as a strip of glass chips under the lead Set, one tap from a filtered Library. A Mac
  /// window has the width to show them all, so they wrap there instead of scrolling.
  @ViewBuilder private var tagRow: some View {
    #if os(macOS)
      GlassEffectContainer(spacing: 8) {
        ChipFlow(spacing: 8) { tagChips }
      }
    #else
      ScrollView(.horizontal, showsIndicators: false) {
        GlassEffectContainer(spacing: 8) {
          HStack(spacing: 8) { tagChips }
            .padding(.horizontal, Self.edgeInset)
        }
      }
      .padding(.horizontal, -Self.edgeInset)
      .scrollClipDisabled()
    #endif
  }

  private var tagChips: some View {
    ForEach(model.availableTags, id: \.self) { tag in
      Button {
        model.showTag(tag)
      } label: {
        GlassTagChip(
          tag, count: model.tagCounts[tag] ?? 0,
          category: SetPresentation.category(for: tag))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("home-tag-\(tag)")
    }
  }

  private var playlistGrid: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading("Playlists", subtitle: "Your sets, sorted for the moment.")
      // Two folders across a phone, as on the Playlists page; a Mac or iPad window fits more
      // rather than stretching two.
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 14)], spacing: 18) {
        ForEach(model.playlistItems) { playlist in
          Button {
            model.showPlaylist(playlist.id)
          } label: {
            PlaylistSleeve(
              name: playlist.name,
              count: playlist.setCount,
              artwork: librarySets.filter { $0.playlistIds.contains(playlist.id) }
                .prefix(3).map { SetPresentation.row($0).artwork },
              category: SetPresentation.category(for: playlist.name)
            )
          }
          .buttonStyle(.orbisPressable)
          .accessibilityIdentifier("playlist-card-\(playlist.id)")
        }
      }
    }
  }

  private func rail<Cards: View>(
    _ name: String, subtitle: String, @ViewBuilder cards: () -> Cards
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading(name, subtitle: subtitle)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) { cards() }
          .padding(.horizontal, Self.edgeInset)
          .scrollTargetLayout()
      }
      // The rail escapes the page's padding and runs to the screen's edges, the way a music
      // app's rows bleed; the inner padding keeps the first card on the page's own margin.
      .padding(.horizontal, -Self.edgeInset)
      .scrollTargetBehavior(.viewAligned)
      .scrollClipDisabled()
    }
    .accessibilityElement(children: .contain)
  }
}

/// The Set Home leads with, large: its artwork, its name, and one button that plays it.
private struct HomeHero: View {
  @Bindable var model: AppModel
  let set: SavedSet
  /// The Set was left part-way, so the button resumes and says how long is left.
  let isResume: Bool

  /// The artwork spans a phone's width; beside the words on a Mac it is a cover's size.
  private static let maxArtworkWidth: CGFloat = HeroLayout.isBeside ? 440 : 560

  private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }
  private var isPlaying: Bool { isCurrent && model.audioPlayer.state == .playing }
  private var canPlay: Bool { self.set.downloadState == "ready" }

  private var playLabel: String {
    if isPlaying { return "Pause" }
    if isResume, let left = SetPresentation.timeLeft(set) { return left }
    return set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil } ?? "Play"
  }

  var body: some View {
    let layout = HeroLayout.stack(spacing: 16)
    layout {
      Button {
        model.openSet(set.id)
      } label: {
        Artwork(
          url: SetPresentation.pageArtwork(set), seed: set.title, size: .header,
          progress: SetPresentation.progress(of: set)
        )
        .shadow(color: .black.opacity(0.45), radius: 28, y: 16)
        .frame(maxWidth: Self.maxArtworkWidth)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityLabel("Open \(set.title)")
      .accessibilityIdentifier("home-hero-\(set.id)")
      VStack(alignment: HeroLayout.alignment, spacing: 16) {
        VStack(alignment: HeroLayout.alignment, spacing: 6) {
          Eyebrow(isResume ? "Continue listening" : "Fresh in your library")
          Text(set.title)
            .font(HeroLayout.isBeside ? Font.orbis.largeTitle : Font.orbis.title)
            .multilineTextAlignment(HeroLayout.textAlignment)
            .lineLimit(3)
          if let creator = set.creator, !creator.isEmpty {
            Text(creator)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: HeroLayout.frameAlignment)
        actions
      }
    }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      if canPlay {
        Button {
          model.togglePlayback(set.id)
        } label: {
          Label(playLabel, systemImage: isPlaying ? "pause.fill" : "play.fill")
            .font(.headline)
            .monospacedDigit()
            .orbisSymbolReplace()
            .padding(.horizontal, 6)
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.large)
        .sensoryFeedback(.impact(weight: .medium), trigger: isPlaying)
        .accessibilityIdentifier("home-hero-play")
        if model.canPlayFromBeginning(set) {
          Button {
            Task { await model.playFromBeginning(set.id) }
          } label: {
            Label("Play from Beginning", systemImage: "backward.end.fill")
              .font(.headline)
              .labelStyle(.iconOnly)
          }
          .buttonStyle(.glass)
          .controlSize(.large)
          .accessibilityIdentifier("home-hero-play-from-beginning")
        }
      }
      Button {
        model.openSet(set.id)
      } label: {
        Label(canPlay ? "Details" : "Open set", systemImage: canPlay ? "ellipsis" : "arrow.right")
          .font(.headline)
          .labelStyle(.titleAndIcon)
      }
      .buttonStyle(.glass)
      .controlSize(.large)
    }
  }
}

/// A link on the clipboard, offered for filing in one tap. The clipboard is only asked whether
/// it holds something shaped like a web address, which needs no permission; the system Paste
/// button reads it, so filing never raises the paste prompt either.
private struct ClipboardBanner: View {
  @Bindable var model: AppModel
  @Environment(\.scenePhase) private var scenePhase
  @State private var offeredChange: Int?

  var body: some View {
    Group {
      if offeredChange != nil {
        HStack(spacing: 12) {
          Image(systemName: "doc.on.clipboard")
            .font(.title3)
            .foregroundStyle(Color.orbis.tint)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            Text("A link is on your clipboard")
              .font(.subheadline.weight(.semibold))
            Text("File it to your library")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          PasteButton(payloadType: String.self) { pasted in
            guard let text = pasted.first else { return }
            offeredChange = nil
            Task { await model.pasteAndFile(text) }
          }
          .labelStyle(.titleOnly)
          .buttonBorderShape(.capsule)
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("home-paste-and-file")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.orbis.paperRaised, in: .rect(cornerRadius: Radius.field))
      }
    }
    .task(id: scenePhase) { await look() }
  }

  private func look() async {
    offeredChange = await ClipboardLink.offerableChange()
  }
}

struct SearchDestination: View {
  @Bindable var model: AppModel
  /// The last queries that found something, newest first, one per line. Kept on the device: they
  /// are a convenience for this person here, not part of the library.
  @AppStorage("orbis.recentSearches") private var recentSearches = ""
  private static let recentLimit = 6
  /// The field is resigned before the query is cleared. SwiftUI does not push a programmatic
  /// change to a search field that is still first responder, so a clear that only set the
  /// binding left the old query on screen while the screen said nothing had been asked.
  @FocusState private var isFieldFocused: Bool

  var body: some View {
    searchPage
      // On the screen, not the results: the results view is not there until a search has run.
      .onSubmit(of: .search) {
        remember(model.searchQuery)
        Task { await model.runSearch() }
      }
      .searchesAsTyped(model)
      .task { await model.loadTracklistsForSearch() }
  }

  private var recentQueries: [String] {
    recentSearches.split(separator: "\n").map(String.init)
  }

  private func remember(_ query: String) {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return }
    let kept = recentQueries.filter { $0.caseInsensitiveCompare(query) != .orderedSame }
    recentSearches = ([query] + kept).prefix(Self.recentLimit).joined(separator: "\n")
  }

  private func search(for query: String) {
    remember(query)
    model.searchQuery = query
    Task { await model.runSearch() }
  }

  private var searchPage: some View {
    #if os(macOS)
      searchBody.sidebarPageTitle("Search")
        .searchable(
          text: $model.searchQuery, placement: .toolbar,
          prompt: "Search Sets and Playlists"
        )
        .searchFocused($isFieldFocused)
        .macSearchToolbarBackground(isSearching: !model.searchQuery.isEmpty)
        // Choosing Search in the sidebar puts the cursor in its field, so typing starts the
        // search; choosing it again while it is open asks for the field the same way.
        .onAppear { isFieldFocused = true }
        .onChange(of: model.searchFocusRequests) { isFieldFocused = true }
    #else
      searchBody
        .sidebarPageTitle("Search")
        // At the top and always shown, the way Apple Music shows it, rather than folded into
        // the tab bar where it reads as a tab and not a field.
        .searchable(
          text: $model.searchQuery, placement: .navigationBarDrawer(displayMode: .always),
          prompt: "Title, tag, or source link"
        )
        .searchFocused($isFieldFocused)
        .onChange(of: model.searchFocusRequests) { isFieldFocused = true }
    #endif
  }

  private var searchBody: some View {
    Group {
      if isUntouched {
        // Nothing has been asked yet, so nothing has failed. One line says what the field
        // searches; the field itself is the action.
        SearchStart(
          model: model, prompt: Self.prompt(total: model.totalCount), recent: recentQueries,
          search: search(for:), clearRecent: { recentSearches = "" }
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search-untouched")
      } else {
        results
      }
    }
  }

  /// Empties the field and the results, from the button. The field is resigned first: while it
  /// holds focus it ignores the binding, so the order is what makes the query leave the screen.
  private func clear() {
    isFieldFocused = false
    model.clearSearch()
  }

  /// "Search your 8 sets."
  static func prompt(total: Int) -> String {
    total == 1 ? "Search your 1 set." : "Search your \(total) sets."
  }

  /// Nothing has been submitted yet. Typing alone changes nothing on screen; Return does.
  private var isUntouched: Bool {
    if case .idle = model.search { return true }
    return false
  }

  /// On a Mac the tracks found inside Tracklists take a column of their own beside the Sets,
  /// where a phone puts them under the Sets.
  @ViewBuilder private var results: some View {
    let cues = isTagQuery ? [] : model.cueMatches(for: model.searchResultsFor ?? "")
    #if os(macOS)
      HStack(alignment: .top, spacing: 0) {
        resultList(cuesBelow: [], foundCues: !cues.isEmpty, backdrop: .none)
        if !cues.isEmpty {
          ScrollView {
            TracklistMatches(model: model, matches: cues)
              .padding()
          }
          .frame(width: 400)
          .accessibilityIdentifier("search-cues-column")
        }
      }
      .background { ArtworkGlow(url: topResult.flatMap(SetPresentation.pageArtwork), reach: 0.55) }
    #else
      resultList(
        cuesBelow: cues, foundCues: !cues.isEmpty,
        backdrop: .artwork(topResult.flatMap(SetPresentation.pageArtwork)))
    #endif
  }

  private var isTagQuery: Bool { SetPresentation.isTagQuery(model.searchResultsFor ?? "") }

  /// The Tags the query names, shown above the Sets so a Tag is one tap from its filter.
  private var matchingTags: [String] {
    SetPresentation.tagsMatching(model.searchResultsFor ?? "", in: model.availableTags)
  }

  /// `foundCues` keeps the heading and the top result up when the only matches are in a
  /// Tracklist shown beside the list rather than in it.
  private func resultList(
    cuesBelow cues: [CueMatch], foundCues: Bool, backdrop: SetList.Backdrop
  ) -> some View {
    let top = topResult
    let tags = matchingTags
    return SetList(
      state: remainingResults,
      heading: nil,
      empty: isTagQuery
        ? AnyView(
          ContentUnavailableView {
            Label("No Tags", systemImage: "tag")
          } description: {
            Text("No Tag matches \"\(model.searchResultsFor ?? "")\".")
          } actions: {
            Button("Clear search", action: clear)
          }
          .accessibilityIdentifier("search-no-tags")
        )
        : AnyView(
          NoResultsState(recoverLabel: "Clear search", recover: clear)
            .accessibilityIdentifier("search-no-results")
        ),
      failureContext: "searching the library",
      filters: nil,
      // A search that found nothing already shows the no-results state, so there is no
      // second one to reach.
      noMatches: nil,
      hero: nil,
      aboveRows: top == nil && !foundCues && tags.isEmpty
        ? nil : AnyView(aboveResults(top, tags: tags)),
      belowRows: cues.isEmpty ? nil : AnyView(TracklistMatches(model: model, matches: cues)),
      footer: searchFooter,
      retry: { await model.runSearch() },
      listIdentifier: "search-list",
      // A result is something to open, which is the whole reason to search.
      select: { set in model.openSet(set.id) },
      currentSetId: model.audioPlayer.currentSetId,
      isPlaying: model.audioPlayer.state == .playing,
      togglePlayback: { set in model.togglePlayback(set.id) },
      backdrop: backdrop
    )
  }

  /// The best match leads, large, with its two quickest actions; the rest are rows under it.
  private var topResult: SavedSet? {
    if case .loaded(let sets) = model.search { sets.first } else { nil }
  }

  private var remainingResults: Loadable<[SavedSet]> {
    if case .loaded(let sets) = model.search { .loaded(Array(sets.dropFirst())) } else { model.search }
  }

  private func aboveResults(_ top: SavedSet?, tags: [String]) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      MacPageTitle.slot("Search")
      heading
        .font(.orbis.sectionTitle)
        .accessibilityAddTraits(.isHeader)
      if !tags.isEmpty {
        tagRow(tags)
      }
      if let top {
        TopResult(model: model, set: top)
      }
      matchingPlaylistRows
    }
  }

  private func tagRow(_ tags: [String]) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          ForEach(tags, id: \.self) { tag in
            Button {
              model.showTag(tag)
            } label: {
              GlassTagChip(
                tag, count: model.tagCounts[tag] ?? 0, category: SetPresentation.category(for: tag))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-result-tag-\(tag)")
          }
        }
        .padding(.horizontal, 16)
      }
    }
    .padding(.horizontal, -16)
    .scrollClipDisabled()
  }

  private var matchingPlaylistRows: AnyView? {
    #if os(macOS)
      guard let query = model.searchResultsFor else { return nil }
      let playlists = model.playlistItems.filter {
        $0.name.localizedCaseInsensitiveContains(query)
      }
      guard !playlists.isEmpty else { return nil }
      return AnyView(
        VStack(alignment: .leading, spacing: 8) {
          Text("Playlists").font(.headline)
          ForEach(playlists) { playlist in
            Button {
              model.showPlaylist(playlist.id)
            } label: {
              PlaylistRow(playlist.name, count: playlist.setCount)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-playlist-\(playlist.name)")
          }
        })
    #else
      nil
    #endif
  }

  /// The heading names the query the results answer, not whatever sits in the field: typing
  /// a second query before submitting must not relabel the results still on screen.
  private var heading: Text {
    let query = model.searchResultsFor ?? ""
    return Text(query.isEmpty ? "Search" : "Results for \"\(query)\"")
  }

  private var searchFooter: String {
    if isTagQuery {
      let count = matchingTags.count
      return count == 1 ? "1 tag" : "\(count) tags"
    }
    guard case .loaded(let sets) = model.search else { return "" }
    return sets.count == 1 ? "1 set" : "\(sets.count) sets"
  }
}

/// Search before anything is asked: the last Tag filters, the Tags and creators to browse by,
/// and the last queries, each one tap from a result.
private struct SearchStart: View {
  @Bindable var model: AppModel
  let prompt: String
  let recent: [String]
  let search: (String) -> Void
  let clearRecent: () -> Void

  /// One Set per creator, the newest, whose artwork stands for them.
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

  /// The recent combinations of Tags the library still holds. A single Tag already leads the
  /// Tags row, which is ordered by recent use.
  private var recentFilters: [[String]] {
    model.recentTagFilters.filter { $0.count > 1 && $0.allSatisfy { model.tagCounts[$0] != nil } }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        MacPageTitle.slot("Search")
        ListingLabel(prompt)
        if !recentFilters.isEmpty {
          section("Recent filters") {
            ChipFlow {
              ForEach(Array(recentFilters.enumerated()), id: \.offset) { index, tags in
                Button {
                  model.showTags(tags)
                } label: {
                  GlassTagChip(
                    tags.joined(separator: " + "),
                    category: SetPresentation.category(for: tags[0]))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search-recent-filter-\(index)")
              }
            }
          }
        }
        if !model.availableTags.isEmpty {
          section("Tags") {
            ChipFlow {
              ForEach(model.availableTags, id: \.self) { tag in
                Button {
                  model.showTag(tag)
                } label: {
                  GlassTagChip(
                    tag, count: model.tagCounts[tag] ?? 0,
                    category: SetPresentation.category(for: tag))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search-tag-\(tag)")
              }
            }
          }
        }
        if !creators.isEmpty {
          section("Creators") {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(alignment: .top, spacing: 16) {
                ForEach(creators) { set in
                  Button {
                    model.showCreator(of: set)
                  } label: {
                    VStack(spacing: 6) {
                      Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .header)
                        .frame(width: 136)
                        .frame(width: 76, height: 76)
                        .clipShape(.circle)
                        .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
                      Text(set.creator ?? "")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .frame(width: 80)
                    }
                  }
                  .buttonStyle(.orbisPressable)
                  .accessibilityLabel("Sets by \(set.creator ?? "")")
                }
              }
              .padding(.horizontal, 16)
            }
            .padding(.horizontal, -16)
            .scrollClipDisabled()
          }
        }
        if !recent.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
              SectionHeading("Recent")
              Button("Clear", action: clearRecent)
                .tint(Color.orbis.tint)
            }
            ForEach(recent, id: \.self) { query in
              Button {
                search(query)
              } label: {
                Label(query, systemImage: "clock")
                  .font(.body)
                  .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                  .contentShape(.rect)
              }
              .buttonStyle(.plain)
              Divider()
            }
          }
        }
      }
      .padding()
    }
    .background { TintGlow() }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title)
      content()
    }
  }
}

/// The best match for a search, large, with Play and Play Next beside it.
private struct TopResult: View {
  @Bindable var model: AppModel
  let set: SavedSet

  var body: some View {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    let isPlaying = isCurrent && model.audioPlayer.state == .playing
    VStack(alignment: .leading, spacing: 12) {
      Button {
        model.openSet(set.id)
      } label: {
        HStack(spacing: 14) {
          Artwork(
            url: SetPresentation.row(set).artwork, seed: set.title, size: .rail,
            progress: SetPresentation.progress(of: set))
          VStack(alignment: .leading, spacing: 2) {
            Text(set.title)
              .font(.headline)
              .lineLimit(3)
              .foregroundStyle(isCurrent ? Color.orbis.tint : Color.primary)
            Text(["Set", set.creator].compactMap { $0 }.joined(separator: " · "))
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(.rect)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(set.title)
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("search-top-result")
      if set.downloadState == "ready" {
        HStack(spacing: 10) {
          Button {
            model.togglePlayback(set.id)
          } label: {
            Label(
              isPlaying ? "Pause" : SetPresentation.timeLeft(set) ?? "Play",
              systemImage: isPlaying ? "pause.fill" : "play.fill"
            )
            .font(.headline)
            .monospacedDigit()
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          Button {
            Task { await model.playNext(set.id) }
          } label: {
            Label("Play Next", systemImage: "text.line.first.and.arrowtriangle.forward")
              .font(.headline)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
          .tint(Color.orbis.tint)
        }
        .controlSize(.large)
      }
    }
    .padding(14)
    .glassEffect(.regular, in: .rect(cornerRadius: 22))
  }
}

/// Tracks inside the library's Tracklists that match the search. Tapping one plays its Set from
/// where that track starts.
private struct TracklistMatches: View {
  @Bindable var model: AppModel
  let matches: [CueMatch]
  private static let limit = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      SectionHeading("In tracklists")
      ForEach(matches.prefix(Self.limit)) { match in
        Button {
          Task { await model.playCue(match.cue, in: match.set.id) }
        } label: {
          HStack(spacing: 12) {
            Image(systemName: "music.note")
              .font(.body.weight(.semibold))
              .foregroundStyle(Color.orbis.tint)
              .frame(width: 40, height: 40)
              .background(Color.orbis.tint.opacity(0.12), in: .circle)
            VStack(alignment: .leading, spacing: 1) {
              Text(match.cue.title)
                .font(.body.weight(.semibold))
                .lineLimit(1)
              Text("\(match.cue.artist) · in \(match.set.title)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let start = match.cue.startSeconds {
              Text(SetPresentation.timestamp(start))
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
          }
          .frame(minHeight: 56)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(match.cue.startSeconds == nil || match.set.downloadState != "ready")
        .accessibilityHint("Plays the set from this track")
        .accessibilityIdentifier("search-cue-\(match.id)")
        Divider()
      }
    }
  }
}
