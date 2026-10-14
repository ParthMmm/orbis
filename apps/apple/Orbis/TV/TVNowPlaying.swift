#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// Now Playing for the room: the artwork, the track and the Set, the progress and the
  /// transport on the left; the Tracklist like lyrics on the right. Always dark, on the artwork's
  /// colour, the way `NowPlayingScreen` is on the phone.
  struct TVNowPlaying: View {
    @Bindable var model: AppModel
    @Binding var isShowingQueue: Bool
    @FocusState private var focus: Focus?

    /// Wide enough for the six round buttons of the transport, which the artwork then matches.
    private static let columnWidth: CGFloat = 720

    private enum Focus {
      case play
    }

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
          .overlay(
            LinearGradient(colors: [.clear, .black.opacity(0.4)], startPoint: .center, endPoint: .bottom)
          )
          .ignoresSafeArea()
      }
      .environment(\.colorScheme, .dark)
      .defaultFocus($focus, .play)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-now-playing")
    }

    private func content(_ set: SavedSet) -> some View {
      let player = model.audioPlayer
      let cues = model.tracklists[set.id]?.cues.filter { $0.startSeconds != nil } ?? []
      let isPlaying = player.state == .playing || player.state == .loading
      return HStack(alignment: .top, spacing: 80) {
        VStack(alignment: .leading, spacing: 28) {
          // The artwork sits back while the Set is paused and steps forward when it plays, the
          // way Apple Music's does: the state of the player, read from across the room.
          Artwork(url: SetPresentation.pageArtwork(set), seed: set.title, size: .header)
            .shadow(color: .black.opacity(0.45), radius: isPlaying ? 36 : 16, y: isPlaying ? 24 : 8)
            .scaleEffect(isPlaying ? 1 : 0.9)
            .orbisAnimation(.playbackToggled, value: isPlaying)
          TVTrackTitle(player: player, set: set)
          TVPlaybackProgress(player: player, fallbackDuration: set.durationSeconds.map(TimeInterval.init))
          transport
        }
        .frame(width: Self.columnWidth)
        .focusSection()
        if !cues.isEmpty {
          TVLyricsTracklist(model: model, set: set, cues: cues)
            .frame(maxWidth: .infinity)
            .focusSection()
        }
      }
      .padding(.top, 24)
      .task(id: set.id) {
        if set.tracklistState != .none { await model.loadTracklist(set.id) }
      }
    }

    /// Back, previous Cue, Play, next Cue, forward, as round glass buttons, and Up Next.
    private var transport: some View {
      let player = model.audioPlayer
      let isPlaying = player.state == .playing || player.state == .loading
      return GlassEffectContainer(spacing: 20) {
        HStack(spacing: 20) {
          Button("Back \(Int(AudioPlayer.skipBack)) seconds", systemImage: "gobackward.\(Int(AudioPlayer.skipBack))") {
            player.skip(by: -AudioPlayer.skipBack)
          }
          .accessibilityIdentifier("now-playing-back")
          Button("Previous track", systemImage: "backward.fill") { player.skipToPreviousCue() }
            .disabled(!player.canSkipCues)
            .accessibilityIdentifier("now-playing-previous-cue")
          Button(isPlaying ? "Pause" : "Play", systemImage: isPlaying ? "pause.fill" : "play.fill") {
            model.togglePlayback()
          }
          .orbisSymbolReplace()
          .focused($focus, equals: .play)
          .accessibilityIdentifier("now-playing-play-toggle")
          Button("Next track", systemImage: "forward.fill") { player.skipToNextCue() }
            .disabled(player.nextCue == nil)
            .accessibilityIdentifier("now-playing-next-cue")
          Button(
            "Forward \(Int(AudioPlayer.skipAhead)) seconds",
            systemImage: "goforward.\(Int(AudioPlayer.skipAhead))"
          ) {
            player.skip(by: AudioPlayer.skipAhead)
          }
          .accessibilityIdentifier("now-playing-forward")
          Button("Up Next", systemImage: "list.bullet") { isShowingQueue = true }
            .accessibilityIdentifier("now-playing-queue")
        }
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.glass)
      .buttonBorderShape(.circle)
      .font(.title2)
    }
  }

  /// The title block: the track playing inside the mix leads when the Tracklist knows it, with
  /// the Set's own name under it; without one the Set leads.
  private struct TVTrackTitle: View {
    let player: AudioPlayer
    let set: SavedSet

    var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        if let cue = player.currentCue {
          Text(cue.title)
            .font(.orbis.title)
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
            .font(.orbis.title)
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

  /// The bar and the clock, in their own view because the player publishes elapsed time twice a
  /// second and only this view should redraw with it. Not a control: the skips are the seek on a
  /// remote. One element to a screen reader, which hears where the Set is and how long it runs.
  private struct TVPlaybackProgress: View {
    let player: AudioPlayer
    let fallbackDuration: TimeInterval?

    var body: some View {
      let duration = player.duration ?? fallbackDuration
      let length = duration ?? 0
      let fraction = length > 0 ? min(max(player.elapsed / length, 0), 1) : 0
      let ticks = player.cueStarts.filter { $0 > 0 && $0 < length }
      VStack(spacing: 10) {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.2))
            Capsule().fill(.white).frame(width: proxy.size.width * fraction)
            ForEach(Array(ticks.enumerated()), id: \.offset) { _, start in
              Rectangle()
                .fill(.black.opacity(0.5))
                .frame(width: 2)
                .offset(x: proxy.size.width * (start / length))
            }
          }
        }
        .frame(height: 8)
        .clipShape(.capsule)
        HStack {
          Text(SetPresentation.timestamp(player.elapsed))
            .accessibilityIdentifier("now-playing-elapsed")
          Spacer()
          if case .loading = player.state {
            ProgressView()
              .accessibilityLabel("Loading audio")
          }
          Spacer()
          Text(duration.map { "-\(SetPresentation.timestamp(max($0 - player.elapsed, 0)))" } ?? "--:--")
            .accessibilityIdentifier("now-playing-remaining")
        }
        .font(.orbis.detail.monospacedDigit())
        .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Position")
      .accessibilityValue(
        duration.map { "\(SetPresentation.spoken(player.elapsed)) of \(SetPresentation.spoken($0))" }
          ?? SetPresentation.spoken(player.elapsed)
      )
      .accessibilityIdentifier("now-playing-seek")
    }
  }

  /// The Tracklist the way Apple Music shows lyrics: one large line per track, the playing one
  /// bright, the ones already heard dimmed, and the list scrolled to keep the playing one in sight
  /// while nothing in it holds the focus. Pressing a line plays from it.
  private struct TVLyricsTracklist: View {
    @Bindable var model: AppModel
    let set: SavedSet
    let cues: [Cue]
    @FocusState private var focusedCue: Int?

    var body: some View {
      let player = model.audioPlayer
      let current = player.currentSetId == set.id ? player.currentCue?.position : nil
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(cues) { cue in
              let isCurrent = cue.position == current
              let isHeard = current.map { cue.position < $0 } ?? false
              Button {
                Task { await model.playCue(cue, in: set.id) }
              } label: {
                TVLyricLine(cue: cue, isCurrent: isCurrent, isHeard: isHeard)
              }
              // Plain, so the line is bare words that the system lifts onto its light platter
              // when focused; white, because the plain style would otherwise write the words in
              // the tint.
              .buttonStyle(.plain)
              .tint(.white)
              .focused($focusedCue, equals: cue.position)
              .accessibilityLabel(
                "\(cue.title), \(cue.artist)"
                  + (cue.startSeconds.map { ", starts at \(SetPresentation.spoken($0))" } ?? "")
              )
              .accessibilityAddTraits(isCurrent ? .isSelected : [])
              .accessibilityIdentifier("now-playing-cue-\(cue.position)")
              .id(cue.position)
            }
          }
        }
        // Soft edges rather than a mask, which clipped the focus platter at the column's sides;
        // the margins keep a focused line out of the faded band.
        .contentMargins(.vertical, 100, for: .scrollContent)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .scrollClipDisabled()
        .scrollIndicators(.hidden)
        .onAppear { if let current { proxy.scrollTo(current, anchor: .center) } }
        .onChange(of: current) { _, position in
          guard let position, focusedCue == nil else { return }
          proxy.scrollTo(position, anchor: .center)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("now-playing-tracklist")
    }
  }

  /// One line of the Tracklist, the way lyrics are drawn: the playing one bright and large, the
  /// ones already heard dimmed.
  private struct TVLyricLine: View {
    let cue: Cue
    let isCurrent: Bool
    let isHeard: Bool

    var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        Text(cue.title)
          .font(isCurrent ? .largeTitle.weight(.heavy) : .title.weight(.heavy))
        Text(
          isCurrent
            ? "\(cue.artist) · playing"
            : "\(cue.artist) · \(cue.startSeconds.map(SetPresentation.timestamp) ?? "")"
        )
        .font(.title3.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(.secondary)
      }
      .opacity(isCurrent ? 1 : isHeard ? 0.4 : 0.65)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 24)
      .padding(.vertical, 12)
    }
  }

  /// The Listening Queue: what plays next, in order, with the Set playing now marked. Pressing an
  /// entry starts it. Covers the whole screen, as Apple TV shows a modal list; Menu or Done closes
  /// it, and Done is there so the empty and failed states still have something to focus.
  struct TVQueue: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
      let playing = model.audioPlayer.currentSetId.flatMap { model.savedSet($0) }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .firstTextBaseline) {
            Text("Up Next")
              .font(.orbis.largeTitle)
              .accessibilityAddTraits(.isHeader)
            Spacer()
            Button("Done") { dismiss() }
              .buttonStyle(.glass)
              .accessibilityIdentifier("queue-done")
          }
          .padding(.bottom, 24)
          content
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background {
        ArtworkGlow(url: playing.flatMap(SetPresentation.pageArtwork), reach: 0.6)
      }
      .environment(\.colorScheme, .dark)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("queue-screen")
      // Read again on open: the other device may be the one that changed it.
      .task { await model.loadQueue() }
    }

    @ViewBuilder private var content: some View {
      switch model.queue {
      case .idle, .loading:
        TVPageState { TVLoading() }
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading the queue") {
          Task { await model.loadQueue() }
        }
        .accessibilityIdentifier("queue-unavailable")
      case .loaded(let queue):
        if queue.entries.isEmpty {
          TVPageState {
            ContentUnavailableView {
              Label("Nothing queued", systemImage: "list.bullet")
            } description: {
              Text("Play a set, or add one with Play Next.")
            }
          }
          .accessibilityIdentifier("queue-empty")
        } else {
          ListingLabel(queue.entries.count == 1 ? "1 set" : "\(queue.entries.count) sets")
            .padding(.bottom, 8)
          ForEach(Array(queue.entries.enumerated()), id: \.element.id) { position, set in
            entry(set, position: position + 1, isActive: queue.isActive(set.id))
          }
        }
      }
    }

    /// One queued Set. The Set playing now carries a mark as well as the tint, because a colour
    /// alone says nothing to a person who cannot see it.
    private func entry(_ set: SavedSet, position: Int, isActive: Bool) -> some View {
      Button {
        Task { await model.playSet(set.id) }
      } label: {
        HStack(spacing: 28) {
          Group {
            if isActive {
              Image(systemName: "speaker.wave.2.fill")
                .foregroundStyle(Color.orbis.tint)
            } else {
              Text(position, format: .number)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
          }
          .font(.title3)
          .frame(minWidth: 48, alignment: .trailing)
          Artwork(url: SetPresentation.row(set).artwork, seed: set.title, size: .lead)
          VStack(alignment: .leading, spacing: 4) {
            Text(set.title)
              .font(.title3.weight(.semibold))
              .foregroundStyle(isActive ? Color.orbis.tint : Color.primary)
            Text(
              [set.creator, set.durationSeconds.map(SetPresentation.length)].compactMap { $0 }.joined(separator: " · ")
            )
            .font(.body)
            .foregroundStyle(.secondary)
          }
          .lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
      .buttonStyle(.card)
      .accessibilityLabel(isActive ? "\(set.title), playing" : "\(set.title), position \(position)")
      .accessibilityAddTraits(isActive ? .isSelected : [])
      .accessibilityIdentifier("queue-entry-\(set.id)")
    }
  }
#endif
