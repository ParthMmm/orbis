import OrbisDesign
import SwiftUI

@main
struct OrbisApp: App {
  @State private var model = OrbisSession.model

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
    }
    #if os(macOS)
      .defaultSize(width: 1000, height: 700)
      .windowToolbarStyle(.unified)
    #endif
  }
}

struct RootView: View {
  let model: AppModel

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
  #else
    @State private var isConfirmingForget = false
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
    #else
      .sheet(
        isPresented: Binding(
          get: { model.isConfigured && model.isEditingConnection },
          set: { if !$0 { model.closeConnectionEditor() } }
        )
      ) {
        NavigationStack {
          ConnectionView(model: model, cancellable: true)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Done") { model.closeConnectionEditor() }
            }
            ToolbarItem(placement: .primaryAction) {
              Menu("More", systemImage: "ellipsis.circle") {
                Button("Refresh") { Task { await model.loadLibrary() } }
                Button("Forget this device", role: .destructive) {
                  isConfirmingForget = true
                }
              }
            }
          }
        }
        .frame(minWidth: 440, minHeight: 360)
        .confirmationDialog("Forget this device?", isPresented: $isConfirmingForget) {
          Button("Forget", role: .destructive) { model.forget() }
          Button("Keep it", role: .cancel) {}
        } message: {
          Text("The address and its token leave this device. Pair it again on the host to come back.")
        }
      }
    #endif
  }

  @ViewBuilder
  private var content: some View {
    if showsLibrary {
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
      NavigationStack {
        ConnectionView(model: model, cancellable: model.isConfigured)
      }
    }
  }

  private var showsLibrary: Bool {
    #if os(macOS)
      model.isConfigured
    #else
      model.isConfigured && !model.isEditingConnection
    #endif
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
    /// Now Playing is a sheet over the whole shell, so it opens the same from any tab.
    @State private var isNowPlayingShown = false
    /// Now Playing grows out of the mini player's artwork and shrinks back into it.
    @Namespace private var nowPlaying

    var body: some View {
      TabView(selection: $model.destination) {
        ForEach([Destination.home, .library, .playlists, .people]) { destination in
          Tab(destination.rawValue, systemImage: destination.symbol, value: destination) {
            NavigationStack {
              DestinationView(model: model, destination: destination)
            }
          }
        }
        Tab(value: Destination.search, role: .search) {
          NavigationStack {
            DestinationView(model: model, destination: .search)
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
      artwork: player.currentSetId.flatMap { model.savedSet($0)?.artworkUrl }
        .flatMap(URL.init(string:)),
      isPlaying: player.state == .playing,
      progress: player.duration.map { $0 > 0 ? player.elapsed / $0 : 0 },
      surface: surface,
      transition: transition,
      toggle: { model.togglePlayback() },
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
          Button("Settings", systemImage: "gearshape") { model.editConnection() }
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
  @State private var isConfirmingForget = false
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
        togglePlayback: { set in model.togglePlayback(set.id) }
      )
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
      // A filing that arrives from the share sheet or the clipboard card opens the naming
      // step the same way one from the field does.
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
      .confirmationDialog(
        "Forget this device?", isPresented: $isConfirmingForget, titleVisibility: .visible
      ) {
        Button("Forget", role: .destructive) { model.forget() }
        Button("Keep it", role: .cancel) {}
      } message: {
        Text(
          "The address and its token leave this device. Pair it again on the host to come back."
        )
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
      matchingLibrary
    #else
      model.visibleSets
    #endif
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
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        HomeRails(model: model)
      }
      .padding()
    }
    .background(Color.orbis.paper)
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
        settingsMenu
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
        Text("Tags")
          .font(.orbis.sectionTitle)
        TagGrid {
          ForEach(model.availableTags, id: \.self) { tag in
            let active = model.activeTag == tag
            Button {
              model.setTagFilter(active ? nil : tag)
            } label: {
              TagTile(
                tag, count: model.tagCounts[tag] ?? 0,
                category: SetPresentation.category(for: tag), active: active)
            }
            .buttonStyle(.plain)
            .orbisAnimation(.tagToggled, value: active)
            .accessibilityIdentifier("tag-filter-\(tag)")
          }
        }
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
      Button("Queue", systemImage: "list.bullet") { isShowingQueue = true }
        .accessibilityIdentifier("library-queue")
    }
    #if os(iOS)
      settingsMenu
    #endif
  }

  private func playSelectedPlaylist() {
    guard let playlistId = model.selectedPlaylistId else { return }
    Task { await model.playPlaylist(playlistId) }
  }

  @ToolbarContentBuilder
  private var settingsMenu: some ToolbarContent {
    ToolbarItem {
      Menu {
        Button("Refresh") { Task { await model.loadLibrary() } }
        Button("Connection settings") { model.editConnection() }
          .accessibilityIdentifier("library-connection-settings")
        Button("Forget this device", role: .destructive) { isConfirmingForget = true }
      } label: {
        Label("Library actions", systemImage: "gearshape")
      }
      .accessibilityIdentifier("library-actions")
    }
  }
}

/// The Library's horizontal rails, in the shape a music app's home gives its sections: a
/// heading over a row of cards that scrolls sideways while the page scrolls down. The cards
/// are artwork, because a Set is recognised by its picture before its words.
struct HomeRails: View {
  @Bindable var model: AppModel

  /// How far into the collection the recently-filed rail reaches. A rail shows what is new,
  /// not the whole library.
  private static let recentLimit = 6
  /// The page's own padding, matched so a rail's first card lines up with the list under it.
  private static let edgeInset: CGFloat = 16

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      if !continueSets.isEmpty {
        rail("Continue Listening") { continueCards }
      }
      if !recentSets.isEmpty {
        rail("Recently filed") { recentCards }
      }
      if !model.playlistItems.isEmpty {
        rail("Playlists") { playlistCards }
      }
      if !model.availableTags.isEmpty {
        tagRow
      }
    }
  }

  private var continueSets: [SavedSet] {
    guard case .loaded(let sets) = model.library else { return [] }
    return SetPresentation.continueListening(sets)
  }

  private var continueCards: some View {
    ForEach(continueSets) { set in
      Button {
        model.openSet(set.id)
      } label: {
        VStack(alignment: .leading, spacing: 0) {
          Artwork(
            url: SetPresentation.row(set).artwork, seed: set.title, size: .header,
            progress: SetPresentation.progress(of: set))
          VStack(alignment: .leading, spacing: 2) {
            Text(set.title)
              .font(.orbis.rowTitle)
              .lineLimit(1)
            if let left = SetPresentation.timeLeft(set) {
              Text(left)
                .font(.orbis.detail)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
          }
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 260)
        .background { ArtworkBackdrop(url: SetPresentation.row(set).artwork, style: .card) }
        .clipShape(.rect(cornerRadius: Radius.list))
      }
      .buttonStyle(.orbisPressable)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel([set.title, SetPresentation.timeLeft(set)].compactMap { $0 }.joined(separator: ", "))
      .accessibilityIdentifier("continue-card-\(set.id)")
    }
  }

  private var tagRow: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Tags")
        .font(.orbis.sectionTitle)
      ChipFlow {
        ForEach(model.availableTags, id: \.self) { tag in
          Button {
            model.setTagFilter(tag)
            model.openedSets[.library] = nil
            model.destination = .library
          } label: {
            TagWord(tag, category: SetPresentation.category(for: tag))
              .orbisRowHeight()
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("home-tag-\(tag)")
        }
      }
    }
  }

  private var recentSets: [SavedSet] {
    guard case .loaded(let sets) = model.visibleSets else { return [] }
    return Array(sets.prefix(Self.recentLimit))
  }

  private func rail<Cards: View>(
    _ name: String, @ViewBuilder cards: () -> Cards
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(name)
        .font(.orbis.sectionTitle)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 12) { cards() }
          .padding(.horizontal, Self.edgeInset)
      }
      // The rail escapes the page's padding and runs to the screen's edges, the way a music
      // app's rows bleed; the inner padding keeps the first card on the page's own margin.
      .padding(.horizontal, -Self.edgeInset)
      .scrollEdgeEffectStyle(.hard, for: .horizontal)
    }
    .accessibilityElement(children: .contain)
  }

  private var recentCards: some View {
    ForEach(recentSets) { set in
      Button {
        model.openSet(set.id)
      } label: {
        let presentation = SetPresentation.row(set)
        Artwork(
          url: presentation.artwork,
          seed: presentation.title,
          size: .rail,
          progress: presentation.progress
        )
        // A rail is a raised surface of cards, not a listing parted by hairlines, so the
        // artwork carries the row radius where the listing keeps its corners square.
        .clipShape(.rect(cornerRadius: Radius.row))
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("recent-card-\(set.id)")
    }
  }

  private var playlistCards: some View {
    ForEach(model.playlistItems) { playlist in
      Button {
        model.destination = .playlists
        model.openPlaylist(playlist.id)
        Task { await model.loadPlaylistMembers(playlist.id) }
      } label: {
        let category = SetPresentation.category(for: playlist.name)
        // The same 16:9 box the artwork cards answer to, so the two rails share one line.
        Color.clear
          .aspectRatio(16 / 9, contentMode: .fit)
          .frame(width: 150)
          .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 2) {
              Text(playlist.name)
                .font(.orbis.rowTitle)
                .lineLimit(2)
              Text(playlist.setCount, format: .number)
                .font(.orbis.detail)
                .foregroundStyle(.secondary)
            }
            .padding(10)
          }
          .background(
            category.dot.opacity(0.35),
            in: .rect(cornerRadius: Radius.row)
          )
      }
      .buttonStyle(.orbisPressable)
      .accessibilityIdentifier("playlist-card-\(playlist.id)")
    }
  }
}

struct SearchDestination: View {
  @Bindable var model: AppModel
  /// The field is resigned before the query is cleared. SwiftUI does not push a programmatic
  /// change to a search field that is still first responder, so a clear that only set the
  /// binding left the old query on screen while the screen said nothing had been asked.
  @FocusState private var isFieldFocused: Bool

  var body: some View {
    searchPage
      // On the screen, not the results: the results view is not there until a search has run.
      .onSubmit(of: .search) { Task { await model.runSearch() } }
      .onChange(of: model.searchQuery) { _, query in
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          model.clearSearch()
        }
      }
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
        .searchable(text: $model.searchQuery, prompt: "Title, tag, or source link")
        .searchFocused($isFieldFocused)
    #endif
  }

  private var searchBody: some View {
    Group {
      if isUntouched {
        // Nothing has been asked yet, so nothing has failed. One line says what the field
        // searches; the field itself is the action.
        ListingLabel(Self.prompt(total: model.totalCount))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color.orbis.paper)
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
    SetList(
      state: model.search,
      heading: heading,
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
      aboveRows: matchingPlaylistRows,
      footer: searchFooter,
      retry: { await model.runSearch() },
      listIdentifier: "search-list",
      // A result is something to open, which is the whole reason to search.
      select: { set in model.openSet(set.id) },
      currentSetId: model.audioPlayer.currentSetId,
      isPlaying: model.audioPlayer.state == .playing,
      togglePlayback: { set in model.togglePlayback(set.id) }
    )
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
