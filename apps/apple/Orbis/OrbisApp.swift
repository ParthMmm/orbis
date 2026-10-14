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

  private let timing = SplashTiming()

  @Environment(\.scenePhase) private var scenePhase

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var splash: SplashPhase = .up
  #endif

  var body: some View {
    ZStack {
      content
      #if os(iOS)
        if splash != .gone {
          SplashView()
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
    private enum SplashPhase: Equatable {
      case up
      case leaving
      case gone
    }

    private func uncoverWhenFirstLoadSettles() async {
      let start = ContinuousClock.now
      while true {
        if timing.shouldDismiss(
          after: start.duration(to: .now),
          firstLoadSettled: !model.isConfigured || model.library.isSettled
        ) {
          break
        }
        do {
          try await Task.sleep(for: .milliseconds(50))
        } catch {
          return
        }
      }
      splash = .leaving
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

enum HeroLayout {
  #if os(macOS)
    static let isBeside = true
  #else
    static let isBeside = false
  #endif

  static func stack(spacing: CGFloat) -> AnyLayout {
    isBeside
      ? AnyLayout(HStackLayout(alignment: .center, spacing: 36))
      : AnyLayout(VStackLayout(spacing: spacing))
  }

  static var alignment: HorizontalAlignment { isBeside ? .leading : .center }
  static var frameAlignment: Alignment { isBeside ? .leading : .center }
  static var textAlignment: TextAlignment { isBeside ? .leading : .center }
}

struct MacPageTitle: View {
  let title: String

  init(_ title: String) {
    self.title = title
  }

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

  func sidebarPageTitle(_ title: String) -> some View {
    #if os(macOS)
      navigationTitle("")
    #else
      navigationTitle(title)
    #endif
  }

  func nowPlayingCover<Content: View>(
    isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    #if os(iOS)
      fullScreenCover(isPresented: isPresented, content: content)
    #else
      sheet(isPresented: isPresented, content: content)
    #endif
  }

  @ViewBuilder func zoomsFromMiniPlayer(_ namespace: Namespace.ID) -> some View {
    #if os(iOS)
      navigationTransition(.zoom(sourceID: MiniPlayer.transitionID, in: namespace))
    #else
      self
    #endif
  }

  @ViewBuilder func largeTitleOnIOS() -> some View {
    #if os(iOS)
      toolbarTitleDisplayMode(.large)
    #else
      self
    #endif
  }

  func searchesAsTyped(_ model: AppModel) -> some View {
    task(id: model.searchQuery) {
      let query = model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !query.isEmpty else {
        model.clearSearch()
        return
      }
      try? await Task.sleep(for: .milliseconds(300))
      guard !Task.isCancelled, query != model.searchResultsFor else { return }
      await model.runSearch()
    }
  }
}
