import OrbisDesign
import SwiftUI

/// Now Playing, laid out the way Apple Music lays out its own: the artwork, the title with its
/// menu, the seek bar and the transport, and a bottom row for the Tracklist, AirPlay and Up Next.
/// The Tracklist takes the artwork's place the way lyrics do, so the mix can be read and stepped
/// through without leaving the player. Always dark, on the artwork's colour. The screen follows
/// the player, and closes when it empties.
struct NowPlayingScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var isRenaming = false
  @State private var isShowingQueue = false
  @State private var showsTracklist = false

  var body: some View {
    let player = model.audioPlayer
    let set = player.currentSetId.flatMap { model.savedSet($0) }
    Group {
      if let set {
        content(set)
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("now-playing")
      } else {
        ContentUnavailableView {
          Label("Nothing playing", systemImage: "play.slash")
        } description: {
          Text("Play a set from your library.")
        }
        .accessibilityIdentifier("now-playing-empty")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      ArtworkGlow(url: set.flatMap(SetPresentation.pageArtwork))
        .overlay(LinearGradient(colors: [.clear, .black.opacity(0.4)], startPoint: .center, endPoint: .bottom))
        .ignoresSafeArea()
    }
    .environment(\.colorScheme, .dark)
    .setChangeStatus(model)
    .sheet(isPresented: $isShowingQueue) { QueueScreen(model: model) }
    .overlay(alignment: .top) {
      #if os(iOS)
        Capsule()
          .fill(.tertiary)
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .accessibilityHidden(true)
      #endif
    }
    #if os(macOS)
      // A Mac sheet has no grabber to pull down and no swipe, so Now Playing closes from a button
      // and from Escape.
      .overlay(alignment: .topLeading) { closeButton }
    #endif
    .accessibilityAction(.escape) { dismiss() }
    .onChange(of: player.currentSetId) { _, id in
      if id == nil { dismiss() }
    }
  }

  #if os(macOS)
    private var closeButton: some View {
      Button("Close", systemImage: "xmark", action: dismiss.callAsFunction)
        .labelStyle(.iconOnly)
        .buttonStyle(.orbisIcon)
        .font(.title3)
        .keyboardShortcut(.cancelAction)
        .padding(12)
        .accessibilityIdentifier("now-playing-close")
    }
  #endif

  /// On a Mac the window is wide enough for the Tracklist to sit beside the player for the whole
  /// Set, where a phone swaps it in for the artwork.
  @ViewBuilder private func content(_ set: SavedSet) -> some View {
    let cues = model.tracklists[set.id]?.cues.filter { $0.startSeconds != nil } ?? []
    #if os(macOS)
      HStack(alignment: .top, spacing: 56) {
        playerColumn(set, cues: cues, showsTracklistInPlace: false)
          .frame(maxWidth: 560)
        if !cues.isEmpty {
          LyricsTracklist(model: model, set: set, cues: cues)
            .frame(maxWidth: .infinity)
            .padding(.top, 36)
        }
      }
      .padding(.horizontal, 32)
      .padding(.top, 24)
    #else
      playerColumn(set, cues: cues, showsTracklistInPlace: showsTracklist)
    #endif
  }

  private func playerColumn(
    _ set: SavedSet, cues: [Cue], showsTracklistInPlace: Bool
  ) -> some View {
    let player = model.audioPlayer
    let isPlaying = player.state == .playing || player.state == .loading
    return VStack(spacing: 0) {
      if showsTracklistInPlace, !cues.isEmpty {
        Button {
          showsTracklist = false
        } label: {
          HStack(spacing: 12) {
            Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .row)
              .frame(width: 70)
            VStack(alignment: .leading, spacing: 1) {
              Text(set.title)
                .font(.headline)
                .lineLimit(1)
              Text(cues.count == 1 ? "1 track · tap one to jump" : "\(cues.count) tracks · tap one to jump")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows the artwork again")
        .padding(.top, 36)
        LyricsTracklist(model: model, set: set, cues: cues)
      } else {
        Spacer(minLength: 28)
        // The artwork sits back while the Set is paused and steps forward when it plays, the way
        // Apple Music's does: the state of the player, read from across the room.
        Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
          .shadow(color: .black.opacity(0.45), radius: isPlaying ? 28 : 12, y: isPlaying ? 18 : 6)
          .scaleEffect(isPlaying ? 1 : 0.86)
          .orbisAnimation(.playbackToggled, value: isPlaying)
        Spacer(minLength: 28)
        HStack(alignment: .center, spacing: 12) {
          TrackTitle(player: player, set: set)
            .frame(maxWidth: .infinity, alignment: .leading)
          SetManagementSection(model: model, set: set, isRenaming: $isRenaming, style: .inline)
        }
      }
      Transport(
        player: player,
        fallbackDuration: set.durationSeconds.map(TimeInterval.init),
        identifierPrefix: "now-playing",
        prominentPlay: false,
        showsCueSkips: true,
        cueStarts: player.cueStarts
      )
      .padding(.top, 20)
      if !showsTracklistInPlace {
        NextCueBar(player: player) { showsTracklist = true }
          .padding(.top, 16)
      }
      Spacer(minLength: 20)
      HStack {
        #if os(iOS)
          Button("Tracklist", systemImage: showsTracklist ? "quote.bubble.fill" : "quote.bubble") {
            showsTracklist.toggle()
          }
          .disabled(cues.isEmpty)
          .accessibilityIdentifier("now-playing-tracklist")
          Spacer()
        #endif
        AirPlayButton()
        Spacer()
        Button("Up Next", systemImage: "list.bullet") { isShowingQueue = true }
          .accessibilityIdentifier("now-playing-queue")
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.orbisIcon)
      .font(.title3)
      .padding(.horizontal, 12)
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 12)
    .orbisAnimation(.cueChanged, value: showsTracklist)
    .task(id: set.id) {
      if set.tracklistState != .none { await model.loadTracklist(set.id) }
    }
  }
}

/// The title block. The track playing inside the mix leads when the Tracklist knows it, with the
/// Set's own name under it; without one the Set leads. Its own view because the Cue follows the
/// clock, and the rest of Now Playing should not redraw twice a second with it.
private struct TrackTitle: View {
  let player: AudioPlayer
  let set: SavedSet

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      if let cue = player.currentCue {
        Text(cue.title)
          .font(.title3.weight(.bold))
          .lineLimit(1)
          .accessibilityLabel("\(cue.title) · \(cue.artist)")
          .accessibilityIdentifier("now-playing-cue")
        Text(set.title)
          .font(.title3)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .accessibilityLabel(set.title)
          .accessibilityIdentifier("now-playing-title")
      } else {
        Text(set.title)
          .font(.title3.weight(.bold))
          .lineLimit(2)
          .accessibilityIdentifier("now-playing-title")
        Text(set.creator ?? set.source.label)
          .font(.title3)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .orbisAnimation(.cueChanged, value: player.currentCue?.position)
  }
}

/// The track the mix moves into next and how long until it does. Tapping it opens the Tracklist.
private struct NextCueBar: View {
  let player: AudioPlayer
  let open: () -> Void

  var body: some View {
    if let next = player.nextCue, let start = next.startSeconds {
      Button(action: open) {
        HStack(spacing: 12) {
          Text("Next in \(SetPresentation.timestamp(max(start - player.elapsed, 0)))")
            .font(.footnote.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.secondary)
          Text("\(next.artist) — \(next.title)")
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.bold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .background(.white.opacity(0.12), in: .rect(cornerRadius: Radius.field))
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("now-playing-next-cue-bar")
    }
  }
}

/// The Tracklist the way Apple Music shows lyrics: one large line per track, the playing one bright,
/// the ones already heard dimmed, and the view scrolled to keep the playing one in sight. Tapping a
/// line plays from it.
private struct LyricsTracklist: View {
  @Bindable var model: AppModel
  let set: SavedSet
  let cues: [Cue]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let player = model.audioPlayer
    let current = player.currentSetId == set.id ? player.currentCue?.position : nil
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          ForEach(cues) { cue in
            let isCurrent = cue.position == current
            let isHeard = current.map { cue.position < $0 } ?? false
            Button {
              Task { await model.playCue(cue, in: set.id) }
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(cue.title)
                  .font(isCurrent ? .largeTitle.weight(.heavy) : .title.weight(.heavy))
                Text(
                  isCurrent
                    ? "\(cue.artist) · playing"
                    : "\(cue.artist) · \(cue.startSeconds.map(SetPresentation.timestamp) ?? "")"
                )
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
              }
              .opacity(isCurrent ? 1 : isHeard ? 0.4 : 0.65)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isCurrent ? .isSelected : [])
            .accessibilityIdentifier("now-playing-cue-\(cue.position)")
            .id(cue.position)
          }
        }
        .padding(.vertical, 24)
      }
      .scrollIndicators(.hidden)
      .mask {
        LinearGradient(
          stops: [
            .init(color: .clear, location: 0), .init(color: .black, location: 0.08),
            .init(color: .black, location: 0.88), .init(color: .clear, location: 1),
          ],
          startPoint: .top, endPoint: .bottom
        )
      }
      .onAppear { if let current { proxy.scrollTo(current, anchor: .center) } }
      .onChange(of: current) { _, position in
        guard let position else { return }
        if reduceMotion {
          proxy.scrollTo(position, anchor: .center)
        } else {
          withAnimation(.smooth) { proxy.scrollTo(position, anchor: .center) }
        }
      }
    }
  }
}
