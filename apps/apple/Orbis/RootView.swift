import OrbisDesign
import SwiftUI

@main
struct OrbisApp: App {
  @State private var model = OrbisSession.model

  var body: some Scene {
    #if os(macOS)
      WindowGroup {
        RootView(model: model)
      }
      .defaultSize(width: 1000, height: 700)
      .windowToolbarStyle(.unified)
      Settings {
        SettingsScreen(model: model)
          .frame(width: 480, height: 620)
      }
    #else
      WindowGroup {
        RootView(model: model)
      }
    #endif
  }
}

struct RootView: View {
  @Bindable var model: AppModel

  /// How long the splash holds and how long it takes to leave.
  private let timing = SplashTiming()

  /// Coming back to the app is when a device learns what the other one has been playing, and where
  /// it left the Set it was playing.
  @Environment(\.scenePhase) private var scenePhase

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The splash covers one launch and one load: a refresh, a Playlist, or a screen change is
    /// not an opening, so nothing puts it back.
    @State private var splash: SplashPhase = .up
  #endif

  var body: some View {
    ZStack {
      content
      #if os(iOS)
        if splash != .gone {
          SplashView()
            // Faded by a value the animation watches rather than inserted and removed with a
            // transition. A transition on a removal did not play here — the splash cut to the
            // Library with the fade left unused — and an opacity the animation is told about
            // does, on a dismissal that arrives from a task either way.
            .opacity(splash == .up ? 1 : 0)
            .animation(timing.fadeAnimation, value: splash)
        }
      #endif
    }
    // The first load starts here rather than on the Library screen, because a screen the
    // window builds and discards while laying itself out takes its task down with it, and a
    // cancelled task cancels the request it is waiting on.
    .task {
      if model.isConfigured, model.library == .idle {
        await model.loadLibrary()
        await model.loadPlaylists()
        await model.loadQueue()
      }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active, model.isConfigured else { return }
      // Read quietly: a spinner over a list the person was already reading would be a flicker for
      // a refresh they did not ask for.
      Task {
        await model.loadQueue()
        await model.refreshLibraryQuietly()
      }
    }
    #if os(iOS)
      .task { await uncoverWhenFirstLoadSettles() }
      .sheet(isPresented: $model.isShowingSettings) {
        SettingsScreen(model: model) { model.isShowingSettings = false }
      }
    #endif
  }

  @ViewBuilder
  private var content: some View {
    if model.isConfigured {
      #if os(macOS)
        SidebarShell(model: model)
      #else
        if sizeClass == .compact {
          CompactShell(model: model)
        } else {
          SidebarShell(model: model)
        }
      #endif
    } else {
      SignInView(model: model)
    }
  }

  #if os(iOS)
    /// The splash's life: up, on its way out, or done with for this launch. The last case keeps
    /// the screen-sized image out of the tree once it stops being drawn.
    private enum SplashPhase: Equatable {
      case up
      case leaving
      case gone
    }

    /// Holds the splash until the first load has an answer, or until the hold's ceiling passes.
    ///
    /// The wait is a bounded loop rather than a signal from the model. The load is watched for
    /// a change to `library`, and the ceiling has to interrupt that watch anyway, so one loop
    /// keeps both exits in one place and leaves `AppModel` with nothing to know about a splash.
    private func uncoverWhenFirstLoadSettles() async {
      let start = ContinuousClock.now
      while true {
        // With no service paired there is no first load to wait for: the floor alone decides,
        // and the connection screen is ready the moment the splash lifts.
        if timing.shouldDismiss(
          after: start.duration(to: .now),
          firstLoadSettled: !model.isConfigured || model.library.isSettled
        ) {
          break
        }
        do {
          // Faster than a handoff anyone can see, slow enough that watching a network answer
          // costs nothing.
          try await Task.sleep(for: .milliseconds(50))
        } catch {
          // The window went away mid-wait, so there is nothing left to reveal.
          return
        }
      }
      splash = .leaving
      // A cross-fade is its own Reduce Motion form: nothing travels, so the accessibility
      // setting has nothing to remove. The sleep is a floor and not a guess, so the image is
      // released after it has finished drawing rather than while it still is.
      try? await Task.sleep(for: timing.fade)
      splash = .gone
    }
  #endif
}

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

struct NowPlayingBar: View {
  @Bindable var model: AppModel
  var surface: MiniPlayer.Surface = .accessory
  var transition: Namespace.ID?
  let open: () -> Void

  var body: some View {
    let player = model.audioPlayer
    MiniPlayer(
      title: player.currentTitle,
      subtitle: player.currentCue.map { "\($0.title) · \($0.artist)" },
      artwork: player.currentSetId.flatMap { model.savedSet($0)?.artworkUrl }
        .flatMap(URL.init(string:)),
      isPlaying: player.state == .playing,
      progress: player.duration.map { $0 > 0 ? player.elapsed / $0 : 0 },
      surface: surface,
      transition: transition,
      toggle: { model.togglePlayback() },
      next: player.nextCue == nil ? nil : { player.skipToNextCue() },
      open: open
    )
  }
}

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
          if model.destination == .library, let id = model.selectedPlaylistId {
            return .playlist(id)
          }
          return .destination(model.destination)
        },
        set: { selected in
          guard let selected else { return }
          switch selected {
          case .destination(let destination):
            model.destination = destination
            if destination == .library {
              Task { await model.selectPlaylist(nil) }
            }
          case .playlist(let id):
            model.destination = .library
            Task { await model.selectPlaylist(id) }
          }
        }
      )
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
            playlistRow(nil, name: "Everything", count: model.totalCount)
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
          .frame(minWidth: 480, minHeight: 640)
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

  /// A playlist in the sidebar. Everything is the whole library, so it carries no colour, and
  /// choosing a playlist is the same as asking for the Library filtered by it.
  private func playlistRow(_ id: String?, name: String, count: Int) -> some View {
    Button {
      Task {
        model.destination = .library
        await model.selectPlaylist(id)
      }
    } label: {
      PlaylistRow(
        name,
        count: count,
        category: id == nil ? nil : SetPresentation.category(for: name),
        isSelected: model.selectedPlaylistId == id
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(model.selectedPlaylistId == id ? [.isSelected] : [])
    .listRowBackground(
      model.selectedPlaylistId == id ? Color.accentColor.opacity(0.18) : Color.clear
    )
    .accessibilityIdentifier(id == nil ? "playlist-all" : "playlist-\(name)")
  }
}

struct DestinationView: View {
  @Bindable var model: AppModel
  let destination: Destination
  /// The queue is read in a sheet, because it is a fact about playback rather than a place in the
  /// library.
  @State private var isShowingQueue = false
  /// Replacing the queue is worth a question only while something is playing.
  @State private var isConfirmingPlaylist = false
  /// The empty Library's action asks the paste field to take focus.
  @State private var focusLink = false
  /// Filing happens in a sheet from the toolbar's +, and the naming step follows in the same
  /// sheet, so the Library itself is the collection and nothing else.
  @State private var isFilingSheetShown = false

  @State private var libraryQuery = ""

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
        activeTag: model.activeTag,
        filters: nil,
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
        hero: nil,
        rails: (model.availableTags.isEmpty && model.activeCreator == nil) || librarySearchIsActive
          ? nil : tagTiles,
        footer: librarySearchIsActive ? "\(libraryMatchCount) sets" : libraryFooter,
        retry: { await model.loadLibrary() },
        select: { set in model.openSet(set.id) },
        currentSetId: model.audioPlayer.currentSetId,
        isPlaying: model.audioPlayer.state == .playing,
        togglePlayback: { set in model.togglePlayback(set.id) },
        groupsByDay: model.librarySort == .newest,
        backdrop: .artwork(libraryLead.flatMap(SetPresentation.pageArtwork))
      )
      .refreshable { await model.refreshLibraryQuietly() }
      .macPageSearch(text: $libraryQuery, prompt: "Find in Library")
      .macSearchToolbarBackground(isSearching: librarySearchIsActive)
      .sidebarPageTitle("Library")
      // Pinned rather than left to the default, so the large title stays large whatever the
      // tab's content state is; the Set page pins its inline counterpart the same way. A Mac
      // has no large title to pin.
      .largeTitleOnIOS()
      .toolbar {
        ToolbarItem {
          Button("File a set", systemImage: "plus") { openFilingSheet() }
            .tint(Color.orbis.tint)
            .accessibilityIdentifier("library-file")
        }
        libraryToolbar
      }
      .sheet(isPresented: $isFilingSheetShown) { filingSheet }
      .onChange(of: model.reveal != nil) { _, hasReveal in
        if hasReveal { isFilingSheetShown = true }
      }
      .sheet(isPresented: $isShowingQueue) {
        QueueScreen(model: model)
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
      rails
        .padding(.horizontal)
        .padding(.top, 8)
        .padding(.bottom, 32)
    }
    .background {
      ArtworkGlow(url: rails.lead.flatMap(SetPresentation.pageArtwork), reach: 0.75)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
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
                let active = model.activeTag == tag
                Button {
                  model.setTagFilter(active ? nil : tag)
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

  /// The design's count says how much the filter is hiding, which is the number a person
  /// wants when a list looks short.
  private var libraryFooter: String {
    let total = model.totalCount
    guard model.isFilteringLibrary else {
      return total == 1 ? "1 set" : "\(total) sets"
    }
    let visible = model.visibleCount
    let outside = total - visible
    let outsideLabel = outside == 1 ? "1 set" : "\(outside) sets"
    return "\(visible) of \(total) · \(outsideLabel) outside this filter"
  }

  private var filingSheet: some View {
    FilingSheet(model: model, focusLink: $focusLink) { isFilingSheetShown = false }
  }

  @ToolbarContentBuilder
  private var libraryToolbar: some ToolbarContent {
    // Playing a Playlist is only offered while the Library is showing one: with Everything
    // selected there is no Playlist to play.
    if model.selectedPlaylistId != nil {
      ToolbarItem {
        Button("Play playlist", systemImage: "play.circle") {
          if model.isPlayingNow {
            isConfirmingPlaylist = true
          } else {
            playSelectedPlaylist()
          }
        }
        .accessibilityIdentifier("library-play-playlist")
      }
    }
    ToolbarItem {
      Menu {
        Picker("Sort by", selection: $model.librarySort) {
          ForEach(LibrarySort.allCases) { sort in
            Text(sort.rawValue).tag(sort)
          }
        }
      } label: {
        Label("Sort", systemImage: "arrow.up.arrow.down")
      }
      .accessibilityIdentifier("library-sort")
    }
    ToolbarItem {
      Button("Queue", systemImage: "list.bullet") { isShowingQueue = true }
        .accessibilityIdentifier("library-queue")
    }
    #if os(iOS)
      settingsButton
    #endif
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

  /// How far into the collection the recently-filed rail reaches. A rail shows what is new,
  /// not the whole library.
  private static let recentLimit = 8
  /// The page's own padding, matched so a rail's first card lines up with the list under it.
  private static let edgeInset: CGFloat = 16

  var body: some View {
    VStack(alignment: .leading, spacing: 36) {
      #if os(iOS)
        ClipboardBanner(model: model)
      #endif
      if let lead {
        HomeHero(model: model, set: lead, isResume: !continueSets.isEmpty)
      }
      if !model.availableTags.isEmpty {
        tagRow
      }
      if continueSets.count > 1 {
        rail("Continue listening", subtitle: "Pick up where you left off.") { continueCards }
      }
      if !recentSets.isEmpty {
        rail("Recently filed", subtitle: "The newest links in your library.") { recentCards }
      }
      if !model.playlistItems.isEmpty {
        playlistGrid
      }
    }
  }

  /// The Set Home leads with: the one most recently left part-way, or else the newest filed.
  var lead: SavedSet? {
    continueSets.first ?? recentSets.first
  }

  private var librarySets: [SavedSet] {
    if case .loaded(let sets) = model.library { sets } else { [] }
  }

  private var continueSets: [SavedSet] {
    SetPresentation.continueListening(librarySets)
  }

  private var recentSets: [SavedSet] {
    guard case .loaded(let sets) = model.visibleSets else { return [] }
    return Array(sets.prefix(Self.recentLimit))
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
    ForEach(continueSets.dropFirst()) { set in
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
    ForEach(recentSets) { set in
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

  /// Tags as a strip of glass chips under the lead Set, one tap from a filtered Library.
  private var tagRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      GlassEffectContainer(spacing: 8) {
        HStack(spacing: 8) {
          ForEach(model.availableTags, id: \.self) { tag in
            Button {
              model.setTagFilter(tag)
              model.openedSets[.library] = nil
              model.destination = .library
            } label: {
              GlassTagChip(
                tag, count: model.tagCounts[tag] ?? 0,
                category: SetPresentation.category(for: tag))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("home-tag-\(tag)")
          }
        }
        .padding(.horizontal, Self.edgeInset)
      }
    }
    .padding(.horizontal, -Self.edgeInset)
    .scrollClipDisabled()
  }

  private var playlistGrid: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionHeading("Playlists", subtitle: "Your sets, sorted for the moment.")
      LazyVGrid(
        columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)],
        spacing: 18
      ) {
        ForEach(model.playlistItems) { playlist in
          Button {
            model.destination = .playlists
            model.openPlaylist(playlist.id)
            Task { await model.loadPlaylistMembers(playlist.id) }
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

  private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }
  private var isPlaying: Bool { isCurrent && model.audioPlayer.state == .playing }
  private var canPlay: Bool { self.set.downloadState == "ready" }

  private var playLabel: String {
    if isPlaying { return "Pause" }
    if isResume, let left = SetPresentation.timeLeft(set) { return left }
    return set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil } ?? "Play"
  }

  var body: some View {
    VStack(spacing: 16) {
      Button {
        model.openSet(set.id)
      } label: {
        Artwork(
          url: SetPresentation.pageArtwork(set), seed: set.title, size: .header,
          progress: SetPresentation.progress(of: set)
        )
        .shadow(color: .black.opacity(0.45), radius: 28, y: 16)
      }
      .buttonStyle(.orbisPressable)
      .accessibilityLabel("Open \(set.title)")
      .accessibilityIdentifier("home-hero-\(set.id)")
      VStack(spacing: 6) {
        Eyebrow(isResume ? "Continue listening" : "Fresh in your library")
        Text(set.title)
          .font(.orbis.title)
          .multilineTextAlignment(.center)
          .lineLimit(3)
        if let creator = set.creator, !creator.isEmpty {
          Text(creator)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity)
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
}

#if os(iOS)
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
      let board = UIPasteboard.general
      guard board.hasURLs || board.hasStrings else {
        offeredChange = nil
        return
      }
      let patterns = try? await board.detectedPatterns(for: [\.probableWebURL])
      offeredChange =
        board.hasURLs || patterns?.contains(\.probableWebURL) == true ? board.changeCount : nil
    }
  }
#endif

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
      // Searches as the query is typed, once typing pauses for 300 ms. A new keystroke cancels
      // the wait, so only the query the person stopped on is sent.
      .task(id: model.searchQuery) {
        let query = model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
          model.clearSearch()
          return
        }
        try? await Task.sleep(for: .milliseconds(300))
        // A submit or a tapped suggestion may already have run this query.
        guard !Task.isCancelled, query != model.searchResultsFor else { return }
        await model.runSearch()
      }
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
        .macSearchToolbarBackground(isSearching: !model.searchQuery.isEmpty)
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

  private var results: some View {
    let top = topResult
    let cues = model.cueMatches(for: model.searchResultsFor ?? "")
    return SetList(
      state: remainingResults,
      heading: nil,
      empty: AnyView(
        NoResultsState(recoverLabel: "Clear search", recover: clear)
          .accessibilityIdentifier("search-no-results")
      ),
      failureContext: "searching the library",
      activeTag: nil,
      filters: nil,
      // A search that found nothing already shows the no-results state, so there is no
      // second one to reach.
      noMatches: nil,
      hero: nil,
      aboveRows: top == nil && cues.isEmpty ? nil : AnyView(aboveResults(top)),
      belowRows: cues.isEmpty ? nil : AnyView(TracklistMatches(model: model, matches: cues)),
      footer: searchFooter,
      retry: { await model.runSearch() },
      listIdentifier: "search-list",
      // A result is something to open, which is the whole reason to search.
      select: { set in model.openSet(set.id) },
      currentSetId: model.audioPlayer.currentSetId,
      isPlaying: model.audioPlayer.state == .playing,
      togglePlayback: { set in model.togglePlayback(set.id) },
      backdrop: .artwork(top.flatMap(SetPresentation.pageArtwork))
    )
  }

  /// The best match leads, large, with its two quickest actions; the rest are rows under it.
  private var topResult: SavedSet? {
    if case .loaded(let sets) = model.search { sets.first } else { nil }
  }

  private var remainingResults: Loadable<[SavedSet]> {
    if case .loaded(let sets) = model.search { .loaded(Array(sets.dropFirst())) } else { model.search }
  }

  private func aboveResults(_ top: SavedSet?) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      heading
        .font(.orbis.sectionTitle)
        .accessibilityAddTraits(.isHeader)
      if let top {
        TopResult(model: model, set: top)
      }
      matchingPlaylistRows
    }
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
              model.destination = .playlists
              model.openPlaylist(playlist.id)
              Task { await model.loadPlaylistMembers(playlist.id) }
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
    guard case .loaded(let sets) = model.search else { return "" }
    return sets.count == 1 ? "1 set" : "\(sets.count) sets"
  }
}

/// Search before anything is asked: the Tags and creators to browse by, and the last queries,
/// each one tap from a result.
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

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        ListingLabel(prompt)
        if !model.availableTags.isEmpty {
          section("Tags") {
            ChipFlow {
              ForEach(model.availableTags, id: \.self) { tag in
                Button {
                  model.setTagFilter(tag)
                  model.openedSets[.library] = nil
                  model.destination = .library
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

extension View {
  func macPageSearch(text: Binding<String>, prompt: String) -> some View {
    #if os(macOS)
      searchable(text: text, placement: .toolbar, prompt: Text(prompt))
    #else
      self
    #endif
  }

  func macSearchToolbarBackground(isSearching: Bool) -> some View {
    #if os(macOS)
      toolbarBackgroundVisibility(isSearching ? .visible : .hidden, for: .windowToolbar)
    #else
      self
    #endif
  }

  /// A Mac sidebar already names the destination; keep the window toolbar for actions.
  func sidebarPageTitle(_ title: String) -> some View {
    #if os(macOS)
      navigationTitle("")
    #else
      navigationTitle(title)
    #endif
  }

  /// Now Playing covers the whole screen where the platform can, the way a music app's player
  /// does; a sheet at full height floats with rounded bottom corners. The zoom from the mini player
  /// keeps it closable with a swipe.
  func nowPlayingCover<Content: View>(
    isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    #if os(iOS)
      fullScreenCover(isPresented: isPresented, content: content)
    #else
      sheet(isPresented: isPresented, content: content)
    #endif
  }

  /// Zooms Now Playing out of the mini player's artwork, where the platform has the transition.
  @ViewBuilder func zoomsFromMiniPlayer(_ namespace: Namespace.ID) -> some View {
    #if os(iOS)
      navigationTransition(.zoom(sourceID: MiniPlayer.transitionID, in: namespace))
    #else
      self
    #endif
  }

  /// `toolbarTitleDisplayMode(.large)` where the platform has a large title, and nothing on a Mac.
  @ViewBuilder func largeTitleOnIOS() -> some View {
    #if os(iOS)
      toolbarTitleDisplayMode(.large)
    #else
      self
    #endif
  }
}
