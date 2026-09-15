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

    var body: some View {
      TabView(selection: $model.destination) {
        Tab(
          Destination.library.rawValue, systemImage: Destination.library.symbol,
          value: Destination.library
        ) {
          NavigationStack {
            DestinationView(model: model, destination: .library)
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
        NowPlayingBar(model: model)
      }
    }
  }

  /// The mini player, fed from the audio player. The accessory placement supplies the glass.
  struct NowPlayingBar: View {
    @Bindable var model: AppModel

    var body: some View {
      let player = model.audioPlayer
      MiniPlayer(
        title: player.currentTitle,
        time: SetPresentation.miniPlayerTime(elapsed: player.elapsed, duration: player.duration),
        artwork: player.currentSetId.flatMap { model.savedSet($0)?.artworkUrl }
          .flatMap(URL.init(string:)),
        isPlaying: player.state == .playing,
        surface: .accessory,
        toggle: {
          if player.state == .playing { player.pause() } else { player.resume() }
        },
        open: {
          if let id = player.currentSetId {
            model.destination = .library
            model.openSet(id)
          }
        }
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

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    switch destination {
    case .library:
      SetList(
        state: model.visibleSets,
        heading: libraryHeading,
        empty: AnyView(
          EmptyLibraryState(recover: { focusLink = true })
            .accessibilityIdentifier("library-empty")
        ),
        failureContext: "loading the library",
        activeTag: model.activeTag,
        filters: model.availableTags.isEmpty ? nil : tagFilters,
        hero: AnyView(pasteHero),
        footer: libraryFooter,
        retry: { await model.loadLibrary() },
        select: { set in model.openSet(set.id) }
      )
      .navigationTitle("Library")
      .toolbar { settingsMenu }
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
    }
  }

  /// The design's heading names the filter in the filtered tag's colour, so the screen says
  /// what it is showing without a separate label.
  private var libraryHeading: Text {
    guard let activeTag = model.activeTag else {
      return Text("Everything")
    }
    let colour = SetPresentation.category(for: activeTag).text
    return Text("Everything \(Text("/ \(activeTag)").foregroundStyle(colour))")
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
    guard let activeTag = model.activeTag else {
      return total == 1 ? "1 set" : "\(total) sets"
    }
    let visible = model.visibleCount
    let outside = total - visible
    let outsideLabel = outside == 1 ? "1 set" : "\(outside) sets"
    return "\(visible) of \(total) · \(outsideLabel) outside this filter"
  }

  /// The design's Library screen opens with the paste field, and the outcome of the last
  /// filing sits under it so the answer appears where the action was taken.
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
        Label("Library actions", systemImage: "ellipsis.circle")
      }
      .accessibilityIdentifier("library-actions")
    }
  }
}

struct SearchDestination: View {
  @Bindable var model: AppModel

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
    // On the screen, not the results: the results view is not there until a search has run,
    // and a submit handler on a view that is not there hears nothing.
    .onSubmit(of: .search) { Task { await model.runSearch() } }
    .onChange(of: model.searchQuery) { _, query in
      if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        model.clearSearch()
      }
    }
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
        NoResultsState(recoverLabel: "Clear search", recover: { model.clearSearch() })
          .accessibilityIdentifier("search-no-results")
      ),
      failureContext: "searching the library",
      activeTag: nil,
      filters: nil,
      hero: nil,
      footer: searchFooter,
      retry: { await model.runSearch() }
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
