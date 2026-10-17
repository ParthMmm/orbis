#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// Home on the TV: the Set to go back to, across the top of the screen in its own light, then
  /// the Tags, who in the Group is listening now, the rails a music app's home gives its sections,
  /// and the Playlists as folders.
  struct TVHome: View {
    @Bindable var model: AppModel
    let people: PeopleModel
    /// How far the page has scrolled, so the hero's light fades as the rails come up under it.
    @State private var scrolled: CGFloat = 0

    private var librarySets: [SavedSet] {
      if case .loaded(let sets) = model.library { sets } else { [] }
    }

    private var home: HomeSelection {
      guard case .loaded(let visible) = model.visibleSets else {
        return HomeSelection(library: librarySets, visible: [])
      }
      return HomeSelection(library: librarySets, visible: visible)
    }

    var body: some View {
      let home = home
      ScrollView {
        VStack(alignment: .leading, spacing: 40) {
          if let lead = home.lead {
            TVHomeHero(model: model, set: lead, isResume: home.isResume)
          }
          if !model.availableTags.isEmpty {
            TVTagChips(tags: model.availableTags, counts: model.tagCounts, identifierPrefix: "home-tag") { tag in
              model.showTag(tag)
            }
          }
          if !people.listening.isEmpty {
            TVRail(title: "Listening now", subtitle: "Your Group, live.") {
              ForEach(people.listening, id: \.personId) { presence in
                TVListeningCard(model: model, presence: presence, isCompact: true) {
                  model.destination = .people
                }
                .accessibilityIdentifier("home-listening-\(presence.username)")
              }
            }
          }
          if !home.continueRail.isEmpty {
            TVRail(title: "Continue listening", subtitle: "Pick up where you left off.") {
              ForEach(home.continueRail) { set in
                TVSetTile(model: model, set: set, detail: SetPresentation.timeLeft(set))
                  .accessibilityIdentifier("continue-card-\(set.id)")
              }
            }
          }
          if !home.recentlyFiled.isEmpty {
            TVRail(title: "Recently filed", subtitle: "The newest links in your library.") {
              ForEach(home.recentlyFiled) { set in
                TVSetTile(model: model, set: set)
                  .accessibilityIdentifier("recent-card-\(set.id)")
              }
            }
          }
          if !model.playlistItems.isEmpty {
            playlists
          }
          if case .loaded(let sets) = model.library, sets.isEmpty {
            TVPageState { TVEmptyLibrary() }
              .accessibilityIdentifier("home-empty")
          }
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .onScrollGeometryChange(for: CGFloat.self) { geometry in
        geometry.contentOffset.y + geometry.contentInsets.top
      } action: { _, offset in
        scrolled = offset
      }
      .background {
        if let lead = home.lead {
          TVBackdrop(url: SetPresentation.pageArtwork(lead))
            .opacity(1 - min(max(scrolled, 0) / TVBackdrop.height, 0.7))
        } else {
          TintGlow()
        }
      }
      .navigationDestination(item: openedSet(model, .home)) { id in
        TVSetPage(model: model, setId: id)
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-home")
    }

    private var playlists: some View {
      VStack(alignment: .leading, spacing: 20) {
        SectionHeading("Playlists", subtitle: "Your sets, sorted for the moment.")
        LazyVGrid(columns: TVLayout.columns, alignment: .leading, spacing: TVLayout.gap) {
          ForEach(model.playlistItems) { playlist in
            Button {
              model.showPlaylist(playlist.id)
            } label: {
              PlaylistSleeve(
                name: playlist.name,
                count: playlist.setCount,
                artwork: model.artwork(ofPlaylist: playlist.id),
                category: SetPresentation.category(for: playlist.name),
                fanWidth: 260, height: 330
              )
            }
            .buttonStyle(.card)
            .accessibilityIdentifier("playlist-card-\(playlist.id)")
          }
        }
        .focusSection()
      }
    }
  }

  /// A Set's artwork as the light across the top of a TV page: blown up past the screen's edges,
  /// blurred so a small square thumbnail still fills it, darkened toward the leading edge where
  /// the words sit, and faded into the page under it.
  struct TVBackdrop: View {
    let url: URL?

    /// How far down the screen the light reaches before the page takes over.
    static let height: CGFloat = 900

    var body: some View {
      ZStack(alignment: .top) {
        Color.orbis.paper
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            image
              .resizable()
              .aspectRatio(contentMode: .fill)
              .frame(width: 2200, height: Self.height + 200)
              .blur(radius: 60, opaque: true)
              .saturation(1.5)
              .frame(maxWidth: .infinity, maxHeight: Self.height, alignment: .top)
              .clipped()
              .transition(.opacity)
          } else if url == nil || phase.error != nil {
            TintGlow()
          }
        }
        .frame(height: Self.height, alignment: .top)
        .mask {
          LinearGradient(
            stops: [.init(color: .black, location: 0.5), .init(color: .clear, location: 1)],
            startPoint: .top, endPoint: .bottom)
        }
        // A scrim from the leading edge, so the title reads over the brightest artwork.
        LinearGradient(
          stops: [
            .init(color: Color.orbis.paper.opacity(0.85), location: 0),
            .init(color: Color.orbis.paper.opacity(0.3), location: 0.55),
            .init(color: Color.orbis.paper.opacity(0.1), location: 1),
          ],
          startPoint: .leading, endPoint: .trailing
        )
        .frame(height: Self.height)
      }
      .ignoresSafeArea()
      .accessibilityHidden(true)
    }
  }

  /// The Set Home leads with, across the top of the screen: its words and the buttons that play it
  /// on the leading side, its artwork large on the trailing side, all standing on the backdrop the
  /// page draws from the same artwork.
  private struct TVHomeHero: View {
    @Bindable var model: AppModel
    let set: SavedSet
    let isResume: Bool
    @FocusState private var focus: Focus?

    private enum Focus {
      case play
    }

    private var isCurrent: Bool { model.audioPlayer.currentSetId == set.id }
    private var isPlaying: Bool { isCurrent && model.audioPlayer.state == .playing }
    private var canPlay: Bool { self.set.downloadState == "ready" }

    private var playLabel: String {
      if isPlaying { return "Pause" }
      return isResume ? "Resume" : "Play"
    }

    /// The creator and the length on one line, so the title stands alone above it.
    private var byline: String? {
      let parts = [
        set.creator.flatMap { $0.isEmpty ? nil : $0 },
        set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil },
      ]
      .compactMap { $0 }
      return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
      HStack(alignment: .bottom, spacing: 80) {
        VStack(alignment: .leading, spacing: 18) {
          Eyebrow(isResume ? "Continue listening" : "Fresh in your library")
          Text(set.title)
            .font(.orbis.largeTitle)
            .lineLimit(2)
            .accessibilityAddTraits(.isHeader)
          if let byline {
            Text(byline)
              .font(.title3)
              .foregroundStyle(.secondary)
          }
          if isResume, let progress = SetPresentation.progress(of: set), let left = SetPresentation.timeLeft(set) {
            HStack(spacing: 16) {
              ProgressView(value: progress)
                .tint(.white)
                .frame(width: 320)
              Text(left)
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(left)
          }
          actions
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Button {
          model.openSet(set.id)
        } label: {
          Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
        }
        .buttonStyle(.card)
        .frame(width: 700)
        .accessibilityLabel("Open \(set.title)")
        .accessibilityValue(
          isCurrent ? (isPlaying ? "Playing" : "Paused") : (SetPresentation.timeLeft(set) ?? "")
        )
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("home-hero-\(set.id)")
      }
      // Tall enough that the hero holds the screen, with the next row just showing under it.
      .frame(minHeight: 620, alignment: .bottom)
      .focusSection()
      .defaultFocus($focus, .play)
    }

    private var actions: some View {
      HStack(spacing: 20) {
        if canPlay {
          Button {
            model.togglePlayback(set.id)
          } label: {
            Label(playLabel, systemImage: isPlaying ? "pause.fill" : "play.fill")
              .orbisSymbolReplace()
          }
          .buttonStyle(.glassProminent)
          .tint(Color.orbis.tint)
          .focused($focus, equals: .play)
          .accessibilityValue(isPlaying ? "" : SetPresentation.timeLeft(set) ?? "")
          .accessibilityIdentifier("home-hero-play")
          if model.canPlayFromBeginning(set) {
            Button {
              Task { await model.playFromBeginning(set.id) }
            } label: {
              Label("Play from Beginning", systemImage: "backward.end.fill")
                .labelStyle(.iconOnly)
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("home-hero-play-from-beginning")
          }
        }
        Button {
          model.openSet(set.id)
        } label: {
          Label(canPlay ? "Details" : "Open set", systemImage: canPlay ? "ellipsis" : "arrow.right")
        }
        .buttonStyle(.glass)
        .accessibilityIdentifier("home-hero-details")
      }
    }
  }
#endif
