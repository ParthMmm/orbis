import OrbisDesign
import SwiftUI

@main
struct OrbisApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
    }
    #if os(macOS)
      .defaultSize(width: 1000, height: 700)
    #endif
  }
}

struct RootView: View {
  let model: AppModel

  /// How long the splash holds and how long it takes to leave.
  private let timing = SplashTiming()

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
      }
    }
    #if os(iOS)
      .task { await uncoverWhenFirstLoadSettles() }
    #endif
  }

  @ViewBuilder
  private var content: some View {
    if model.isConfigured, !model.isEditingConnection {
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

    var body: some View {
      TabView(selection: $model.destination) {
        ForEach([Destination.home, .library]) { destination in
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
      .tabViewBottomAccessory(isEnabled: model.audioPlayer.currentSetId != nil) {
        NowPlayingBar(model: model) { isNowPlayingShown = true }
      }
      .sheet(isPresented: $isNowPlayingShown) {
        NowPlayingScreen(model: model)
      }
    }
  }

  /// The mini player, fed from the audio player. The accessory placement supplies the glass.
  struct NowPlayingBar: View {
    @Bindable var model: AppModel
    /// Opens Now Playing, which the shell presents.
    let open: () -> Void

    var body: some View {
      let player = model.audioPlayer
      MiniPlayer(
        title: player.currentTitle,
        artwork: player.currentSetId.flatMap { model.savedSet($0)?.artworkUrl }
          .flatMap(URL.init(string:)),
        isPlaying: player.state == .playing,
        progress: player.duration.map { $0 > 0 ? player.elapsed / $0 : 0 },
        surface: .accessory,
        toggle: {
          if player.state == .playing { player.pause() } else { player.resume() }
        },
        open: open
      )
    }
  }
#endif

/// iPad and macOS. The same destinations become sidebar items. A plain list with explicit
/// selection buttons is used because SwiftUI's selection-based `List` initializers are
/// unavailable on iOS.
struct SidebarShell: View {
  @Bindable var model: AppModel

  var body: some View {
    NavigationSplitView {
      List {
        ForEach(Destination.allCases) { destination in
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
    } detail: {
      NavigationStack {
        DestinationView(model: model, destination: model.destination)
      }
    }
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
  /// The empty Library's action asks the paste field to take focus.
  @State private var focusLink = false
  /// Filing happens in a sheet from the toolbar's +, and the naming step follows in the same
  /// sheet, so the Library itself is the collection and nothing else.
  @State private var isFilingSheetShown = false

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    switch destination {
    case .home:
      home
    case .library:
      SetList(
        state: model.visibleSets,
        heading: libraryHeading,
        empty: AnyView(
          EmptyLibraryState(recover: { openFilingSheet() })
            .accessibilityIdentifier("library-empty")
        ),
        failureContext: "loading the library",
        activeTag: model.activeTag,
        filters: model.availableTags.isEmpty ? nil : tagFilters,
        // Only a filter can hide every Set. Without one, an empty list is an empty collection
        // and keeps the empty collection's copy.
        noMatches: model.activeTag == nil
          ? nil
          : AnyView(
            NoResultsState(recoverLabel: "Clear filters", recover: { model.setTagFilter(nil) })
              .accessibilityIdentifier("library-no-matches")
          ),
        hero: linkWaiting,
        rails: nil,
        footer: libraryFooter,
        retry: { await model.loadLibrary() },
        select: { set in model.openSet(set.id) },
        currentSetId: model.audioPlayer.currentSetId,
        isPlaying: model.audioPlayer.state == .playing,
        togglePlayback: { set in model.togglePlayback(set.id) }
      )
      .navigationTitle("Library")
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
        settingsMenu
      }
      .sheet(isPresented: $isFilingSheetShown) { filingSheet }
      // A filing that arrives from the share sheet or the clipboard card opens the naming
      // step the same way one from the field does.
      .onChange(of: model.reveal != nil) { _, hasReveal in
        if hasReveal { isFilingSheetShown = true }
      }
      .navigationDestination(item: $model.openedSetId) { id in
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
    case .search:
      SearchDestination(model: model)
        // The one open Set is shared with the Library, so a Set found here opens the same page.
        .navigationDestination(item: $model.openedSetId) { id in
          SetDetailScreen(model: model, setId: id)
        }
    }
  }

  /// The large title already says Library, so the list carries no heading of its own; the
  /// active filter is underlined in the ledger row instead.
  private var libraryHeading: Text? { nil }

  /// Home: what is new and where to go, in rails, with a waiting link above them. The full
  /// collection is the Library tab.
  private var home: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let linkWaiting {
          linkWaiting
        }
        HomeRails(model: model)
      }
      .padding()
    }
    .background(Color.orbis.paper)
    .navigationTitle("Home")
    .largeTitleOnIOS()
    .toolbar {
      ToolbarItem {
        Button("File a set", systemImage: "plus") { openFilingSheet() }
          .tint(Color.orbis.tint)
          .accessibilityIdentifier("home-file")
      }
      settingsMenu
    }
    .sheet(isPresented: $isFilingSheetShown) { filingSheet }
    .onChange(of: model.reveal != nil) { _, hasReveal in
      if hasReveal { isFilingSheetShown = true }
    }
    .navigationDestination(item: $model.openedSetId) { id in
      SetDetailScreen(model: model, setId: id)
    }
  }

  private func openFilingSheet() {
    isFilingSheetShown = true
    focusLink = true
  }

  /// Each Tag is a word; the active one is underlined. Pressing it again clears the filter.
  private var tagFilters: AnyView {
    AnyView(
      HStack(spacing: 14) {
        ForEach(model.availableTags, id: \.self) { tag in
          let active = model.activeTag == tag
          Button {
            model.setTagFilter(active ? nil : tag)
          } label: {
            TagWord(tag, category: SetPresentation.category(for: tag), active: active)
              .orbisRowHeight()
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(active ? .isSelected : [])
          .accessibilityIdentifier("tag-filter-\(tag)")
        }
      }
    )
  }

  /// The design's count says how much the filter is hiding, which is the number a person
  /// wants when a list looks short.
  private var libraryFooter: String {
    let total = model.totalCount
    guard model.activeTag != nil else {
      return total == 1 ? "1 set" : "\(total) sets"
    }
    let visible = model.visibleCount
    let outside = total - visible
    let outsideLabel = outside == 1 ? "1 set" : "\(outside) sets"
    return "\(visible) of \(total) · \(outsideLabel) outside this filter"
  }

  /// The filing sheet: the paste field, then the naming step once a link is filed. The outcome
  /// of the last filing sits under the field so the answer appears where the action was taken,
  /// and the sheet stays up so the next link can follow.
  private var filingSheet: some View {
    NavigationStack {
      ScrollView {
        pasteHero
          .padding()
      }
      .background(Color.orbis.paper)
      .navigationTitle(model.reveal == nil ? "File a set" : "Name this set")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", role: .close) { isFilingSheetShown = false }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  /// What a link on the clipboard gets: one card above the list that files it in a tap. The
  /// clipboard is not read for it; the system says whether it holds a link, and reading waits
  /// for the tap, which is the permission.
  private var linkWaiting: AnyView? {
    #if os(iOS)
      AnyView(
        LinkWaitingCard(notice: model.pasteNotice) { text in
          Task { await model.pasteAndFile(text) }
        })
    #else
      nil
    #endif
  }

  private var pasteHero: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let reveal = model.reveal {
        revealPanel(reveal)
      } else {
        PasteHero(
          link: $model.linkToFile,
          state: SetPresentation.linkState(
            isFiling: model.isFiling, failure: model.fileFailure),
          compact: isCompact,
          paste: { text in Task { await model.pasteAndFile(text) } },
          pasteNotice: model.pasteNotice,
          focusRequest: $focusLink
        ) {
          Task { await model.fileLink() }
        }
        if let confirmation = model.fileConfirmation {
          Text(confirmation)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("file-confirmation")
        }
      }
    }
  }

  /// The step the hero promises: the title and Tags the service read from the link, open to
  /// correction. Nothing here is required, so pressing Done is the common case.
  private func revealPanel(_ reveal: AppModel.Reveal) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Name this set")
          .font(.orbis.sectionTitle)
        SourceStamp(reveal.set.source.label)
      }
      TextField(
        "Title",
        text: Binding(
          get: { model.reveal?.title ?? "" },
          set: { model.reveal?.title = $0 }
        )
      )
      .textFieldStyle(.plain)
      .padding(.leading)
      .padding(.vertical, 8)
      .padding(.trailing)
      .background(Color.orbis.field, in: .rect(cornerRadius: Radius.field))
      .accessibilityIdentifier("reveal-title")
      TagInput(
        tags: Binding(
          get: { model.reveal?.tags ?? [] },
          set: { model.reveal?.tags = $0 }
        ),
        suggestions: model.availableTags
      )
      HStack {
        Button("Done") { Task { await model.saveReveal() } }
          .buttonStyle(OrbisPrimaryButtonStyle())
          .disabled(model.isSavingReveal)
          // Return reaches the default action, which is the common case here; the Tag field keeps
          // Return while it has focus.
          .keyboardShortcut(.defaultAction)
          .accessibilityIdentifier("reveal-done")
        Button("Not now") { model.closeReveal() }
          .buttonStyle(.plain)
          .accessibilityIdentifier("reveal-dismiss")
      }
      if let failure = model.revealFailure {
        VStack(alignment: .leading, spacing: 4) {
          Text(failure.message)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("reveal-error")
          CopyFailureButton(
            report: FailureReport(failure: failure, context: "naming a filed set"))
        }
      } else if reveal.set.metadataState == "failed" {
        HStack(spacing: 6) {
          Text("Orbis could not name this set.")
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
          Button("Try again") { Task { await model.retryMetadata() } }
            .buttonStyle(.plain)
            .foregroundStyle(Color.orbis.tint)
            .disabled(model.isSavingReveal)
            .accessibilityIdentifier("reveal-retry")
        }
      }
    }
    .padding()
    .orbisRaised(radius: Radius.hero)
  }

  private var isCompact: Bool {
    #if os(iOS)
      sizeClass == .compact
    #else
      false
    #endif
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
      if !recentSets.isEmpty {
        rail("Recently filed") { recentCards }
      }
      if !model.playlistItems.isEmpty {
        rail("Playlists") { playlistCards }
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
      .buttonStyle(.plain)
      .accessibilityIdentifier("recent-card-\(set.id)")
    }
  }

  private var playlistCards: some View {
    ForEach(model.playlistItems) { playlist in
      Button {
        Task { await model.selectPlaylist(playlist.id) }
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
                .font(.orbis.mono)
                .foregroundStyle(.secondary)
            }
            .padding(10)
          }
          .background(
            category.dot.opacity(0.35),
            in: .rect(cornerRadius: Radius.row)
          )
      }
      .buttonStyle(.plain)
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
    .navigationTitle("Search")
    .searchable(text: $model.searchQuery, prompt: "Title, tag, or source link")
    .searchFocused($isFieldFocused)
    // On the screen, not the results: the results view is not there until a search has run,
    // and a submit handler on a view that is not there hears nothing.
    .onSubmit(of: .search) { Task { await model.runSearch() } }
    .onChange(of: model.searchQuery) { _, query in
      // Typing then deleting every character leaves the field where the person put it, so this
      // path only drops the results. Resigning the field belongs to the clear action.
      if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        model.clearSearch()
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
  /// `toolbarTitleDisplayMode(.large)` where the platform has a large title, and nothing on a Mac.
  @ViewBuilder fileprivate func largeTitleOnIOS() -> some View {
    #if os(iOS)
      toolbarTitleDisplayMode(.large)
    #else
      self
    #endif
  }
}
