#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// A tab in the Apple TV's top bar. The five places map onto the `Destination` the phone and Mac
  /// use, so `model.openedSets` and `showPlaylist` keep working; Now Playing and Settings are the
  /// TV's own, as Apple Music lays them out on the TV.
  enum TVTab: Hashable, Identifiable, CaseIterable {
    case home
    case library
    case playlists
    case people
    case search
    case nowPlaying
    case settings

    var id: Self { self }

    init(_ destination: Destination) {
      self = Self.allCases.first { $0.destination == destination } ?? .home
    }

    var destination: Destination? {
      switch self {
      case .home: .home
      case .library: .library
      case .playlists: .playlists
      case .people: .people
      case .search: .search
      case .nowPlaying, .settings: nil
      }
    }

    var label: (String, systemImage: String) {
      switch self {
      case .home: ("Home", systemImage: "house")
      case .library: ("Library", systemImage: "music.note.list")
      case .playlists: ("Playlists", systemImage: "rectangle.stack")
      case .people: ("People", systemImage: "person.2")
      case .search: ("Search", systemImage: "magnifyingglass")
      case .nowPlaying: ("Now Playing", systemImage: "waveform")
      case .settings: ("Settings", systemImage: "gearshape")
      }
    }

    var role: TabRole? { self == .search ? .search : nil }

    var identifier: String {
      switch self {
      case .home: "tv-tab-home"
      case .library: "tv-tab-library"
      case .playlists: "tv-tab-playlists"
      case .people: "tv-tab-people"
      case .search: "tv-tab-search"
      case .nowPlaying: "tv-tab-now-playing"
      case .settings: "tv-tab-settings"
      }
    }
  }

  /// The TV's root: the system top tab bar over the five places, Now Playing while a Set is in
  /// the player, and Settings. The Siri Remote's play/pause reaches the player from anywhere.
  ///
  /// The shell holds People, so Home and the People tab show the same listeners from one stream,
  /// which stays open while the app is: a TV is left on Home, and Home is where it says who is
  /// listening.
  struct TVShell: View {
    @Bindable var model: AppModel
    @State private var people: PeopleModel
    @State private var tab: TVTab
    /// Up Next covers the whole shell, so playback ending while it is open cannot take the
    /// presenting tab away under it.
    @State private var isShowingQueue = false

    init(model: AppModel) {
      self.model = model
      _people = State(initialValue: PeopleModel(app: model))
      _tab = State(initialValue: TVTab(model.destination))
    }

    private var tabs: [TVTab] {
      TVTab.allCases.filter { $0 != .nowPlaying || model.audioPlayer.currentSetId != nil }
    }

    /// The one place a tab changes: the bar and the model's destination move together, so a Set
    /// opened from a tab lands in that tab's own stack.
    private func select(_ next: TVTab) {
      tab = next
      if let destination = next.destination { model.destination = destination }
    }

    private var selection: Binding<TVTab> {
      Binding(
        get: { tabs.contains(tab) ? tab : .home },
        set: { select($0) })
    }

    var body: some View {
      TabView(selection: selection) {
        ForEach(tabs) { tab in
          Tab(value: tab, role: tab.role) {
            NavigationStack {
              content(for: tab)
            }
          } label: {
            tabLabel(tab)
          }
        }
      }
      .onChange(of: model.audioPlayer.currentSetId) { _, id in
        if id == nil, tab == .nowPlaying { select(.home) }
      }
      // A chip sets the model's destination, the way it does on the phone; the bar follows.
      .onChange(of: model.destination) { _, destination in
        let next = TVTab(destination)
        if next != tab { tab = next }
      }
      .fullScreenCover(isPresented: $isShowingQueue) { TVQueue(model: model) }
      .task(id: model.client?.token) { await people.load() }
      // Read again whenever People opens, so Social turned on from a phone shows here too.
      .onChange(of: tab) { _, next in
        if next == .people { Task { await people.load() } }
      }
      .task(id: TVPresenceKey(token: model.client?.token, social: people.isSocial)) {
        await people.watchPresence()
      }
      .onPlayPauseCommand { model.togglePlayback() }
    }

    /// Seven tabs overrun the bar once Now Playing joins it, so Settings is its gear alone,
    /// the way a system app's trailing tab is.
    @ViewBuilder private func tabLabel(_ tab: TVTab) -> some View {
      if tab == .settings {
        Image(systemName: tab.label.systemImage)
          .accessibilityLabel(tab.label.0)
      } else {
        Label(tab.label.0, systemImage: tab.label.systemImage)
      }
    }

    @ViewBuilder private func content(for tab: TVTab) -> some View {
      switch tab {
      case .settings:
        TVSettings(model: model)
      case .nowPlaying:
        TVNowPlaying(model: model, isShowingQueue: $isShowingQueue)
      case .home:
        TVHome(model: model, people: people)
      case .library:
        TVLibrary(model: model)
      case .playlists:
        TVPlaylists(model: model)
      case .people:
        TVPeople(model: model, people: people)
      case .search:
        TVSearch(model: model)
      }
    }
  }

  /// Keys the Presence stream, so it opens once Social is on and again for a new sign-in.
  private struct TVPresenceKey: Equatable {
    let token: String?
    let social: Bool
  }
#endif
