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
    #elseif os(iOS)
      // An iPad or a mirrored iPhone window can shrink below the narrowest phone the layouts are
      // drawn for. The floor is the shortest side of the smallest iPhone, so a phone in either
      // orientation never meets it.
      WindowGroup {
        RootView(model: model)
          .frame(minWidth: 320, minHeight: 320)
      }
      .windowResizability(.contentMinSize)
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
  /// The phase the last refresh task saw, so the one that runs as the window opens is told apart
  /// from a return to the app.
  @State private var observedPhase: ScenePhase?
  /// Set while the greeting after a join fades, so the fade has a value to watch.
  @State private var isWelcomeLeaving = false

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The splash covers one launch and one load: a refresh, a Playlist, or a screen change is
    /// not an opening, so nothing puts it back.
    @State private var splash: SplashPhase = .up
  #endif

  var body: some View {
    ZStack {
      content
      if let username = model.welcomedUsername {
        WelcomeView(username: username)
          .opacity(isWelcomeLeaving ? 0 : 1)
          .animation(timing.fadeAnimation, value: isWelcomeLeaving)
          .task { await fadeWelcome() }
      }
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
    // Keyed to the phase, so leaving the app cancels a refresh still in flight instead of letting
    // it pile up under the next one.
    .task(id: scenePhase) {
      // The task also runs for the phase the window opens in, which is not a return to the app:
      // the first load above covers that.
      let previous = observedPhase
      observedPhase = scenePhase
      guard previous != nil, scenePhase == .active, model.isConfigured else { return }
      // Read quietly: a spinner over a list the person was already reading would be a flicker for
      // a refresh they did not ask for.
      await model.loadQueue()
      await model.refreshLibraryQuietly()
    }
    #if os(iOS)
      .task { await uncoverWhenFirstLoadSettles() }
      .sheet(isPresented: $model.isShowingSettings) {
        SettingsScreen(model: model) { model.isShowingSettings = false }
      }
    #endif
  }

  /// Holds the greeting long enough to read, then fades it the way the splash fades.
  /// A cancelled wait ends the greeting at once rather than leaving it over the library.
  private func fadeWelcome() async {
    try? await Task.sleep(for: timing.welcomeHold)
    isWelcomeLeaving = true
    try? await Task.sleep(for: timing.fade)
    model.welcomedUsername = nil
    isWelcomeLeaving = false
  }

  @ViewBuilder
  private var content: some View {
    if model.isConfigured {
      #if os(macOS)
        SidebarShell(model: model)
      #elseif os(tvOS)
        TVShell(model: model)
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

/// A hero's artwork beside its words where the window is wide, a Mac or an iPad at regular width,
/// and above them where it is narrow, the way the design draws each.
struct HeroLayout {
  let isBeside: Bool

  init(_ sizeClass: UserInterfaceSizeClass?) {
    #if os(macOS)
      isBeside = true
    #else
      isBeside = sizeClass == .regular
    #endif
  }

  func stack(spacing: CGFloat) -> AnyLayout {
    isBeside
      ? AnyLayout(HStackLayout(alignment: .center, spacing: 36))
      : AnyLayout(VStackLayout(spacing: spacing))
  }

  var alignment: HorizontalAlignment { isBeside ? .leading : .center }
  var frameAlignment: Alignment { isBeside ? .leading : .center }
  var textAlignment: TextAlignment { isBeside ? .leading : .center }
}

/// The page's name over its content on a Mac, where the sidebar shell leaves the window toolbar
/// untitled and keeps it for actions. An iPhone or iPad names the page in its navigation bar.
struct MacPageTitle: View {
  let title: String

  init(_ title: String) {
    self.title = title
  }

  /// The title for a page slot such as a list's hero: present on a Mac, absent elsewhere.
  static func slot(_ title: String) -> AnyView? {
    #if os(macOS)
      AnyView(MacPageTitle(title))
    #else
      nil
    #endif
  }

  var body: some View {
    Text(title)
      .font(.orbis.largeTitle)
      .accessibilityAddTraits(.isHeader)
      .frame(maxWidth: .infinity, alignment: .leading)
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

  /// Searches as the query is typed, once typing pauses for 300 ms. A new keystroke cancels the
  /// wait, so only the query the person stopped on is sent.
  func searchesAsTyped(_ model: AppModel) -> some View {
    task(id: model.searchQuery) {
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
  }
}
