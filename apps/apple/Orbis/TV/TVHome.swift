#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  struct TVHome: View {
    @Bindable var model: AppModel

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
              model.setTagFilter(tag)
              model.openedSets[.library] = nil
              model.destination = .library
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
      .background { ArtworkGlow(url: home.lead.flatMap(SetPresentation.pageArtwork), reach: 0.75) }
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
                artwork: librarySets.filter { $0.playlistIds.contains(playlist.id) }
                  .prefix(3).map { SetPresentation.row($0).artwork },
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
      if isResume, let left = SetPresentation.timeLeft(set) { return left }
      return set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil } ?? "Play"
    }

    var body: some View {
      HStack(alignment: .center, spacing: 64) {
        Button {
          model.openSet(set.id)
        } label: {
          Artwork(
            url: SetPresentation.pageArtwork(set), seed: set.title, size: .header,
            progress: SetPresentation.progress(of: set)
          )
        }
        .buttonStyle(.card)
        .frame(width: 720)
        .accessibilityLabel("Open \(set.title)")
        .accessibilityValue(
          isCurrent ? (isPlaying ? "Playing" : "Paused") : (SetPresentation.timeLeft(set) ?? "")
        )
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("home-hero-\(set.id)")
        VStack(alignment: .leading, spacing: 18) {
          Eyebrow(isResume ? "Continue listening" : "Fresh in your library")
          Text(set.title)
            .font(.orbis.largeTitle)
            .lineLimit(3)
            .accessibilityAddTraits(.isHeader)
          if let creator = set.creator, !creator.isEmpty {
            Text(creator)
              .font(.title3)
              .foregroundStyle(.secondary)
          }
          HStack(spacing: 20) {
            if canPlay {
              Button {
                model.togglePlayback(set.id)
              } label: {
                Label(playLabel, systemImage: isPlaying ? "pause.fill" : "play.fill")
                  .monospacedDigit()
                  .orbisSymbolReplace()
              }
              .buttonStyle(.glassProminent)
              .tint(Color.orbis.tint)
              .focused($focus, equals: .play)
              .accessibilityLabel(isPlaying ? "Pause" : isResume ? "Resume" : "Play")
              .accessibilityValue(isPlaying ? "" : SetPresentation.timeLeft(set) ?? "")
              .accessibilityIdentifier("home-hero-play")
            }
            Button {
              model.openSet(set.id)
            } label: {
              Label(canPlay ? "Details" : "Open set", systemImage: canPlay ? "ellipsis" : "arrow.right")
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("home-hero-details")
          }
          .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .focusSection()
      .defaultFocus($focus, .play)
    }
  }
#endif
