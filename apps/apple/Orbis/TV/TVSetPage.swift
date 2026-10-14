#if os(tvOS)
  import OrbisDesign
  import SwiftUI

  /// One Set's page on the TV: its artwork large on the left, its words and the few things a
  /// person does to it on the right, and its Tracklist under both.
  ///
  /// The page reads the Set from the model on every pass rather than holding a copy, so a change
  /// made on a phone shows up here on the next refresh and a removal closes the page.
  struct TVSetPage: View {
    @Bindable var model: AppModel
    let setId: String
    @FocusState private var focus: Focus?

    private enum Focus {
      case play
      case cancel
    }

    var body: some View {
      Group {
        if let set = model.savedSet(setId) {
          page(set)
            .task(id: setId) {
              if set.tracklistState != .none { await model.loadTracklist(setId) }
            }
        } else if case .loaded = model.library {
          ContentUnavailableView {
            Label("This set is gone", systemImage: "questionmark.folder")
          } description: {
            Text("It was removed from your library.")
          }
          .accessibilityIdentifier("detail-missing")
        } else {
          TVLoading()
        }
      }
      // Said aloud, because a refusal or "Playing next" lands under the buttons, out of the way of
      // a screen reader that is on them.
      .onChange(of: model.setFailure) { _, failure in
        if let failure { AccessibilityNotification.Announcement(failure.message).post() }
      }
      .onChange(of: model.queueNotice) { _, notice in
        if let notice { AccessibilityNotification.Announcement(notice).post() }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("tv-set-page")
    }

    private func page(_ set: SavedSet) -> some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 56) {
          HStack(alignment: .center, spacing: 72) {
            Artwork(
              url: SetPresentation.pageArtwork(set), seed: set.title, size: .header,
              progress: SetPresentation.progress(of: set)
            )
            .shadow(color: .black.opacity(0.45), radius: 36, y: 20)
            .frame(maxWidth: 760)
            VStack(alignment: .leading, spacing: 18) {
              Eyebrow(set.creator ?? set.source.label)
              Text(set.title)
                .font(.orbis.largeTitle)
                .lineLimit(3)
                .accessibilityAddTraits(.isHeader)
              if let seconds = set.durationSeconds, seconds > 0 {
                Text(SetPresentation.length(seconds))
                  .font(.title3)
                  .foregroundStyle(.secondary)
              }
              if !set.tags.isEmpty {
                TVTagChips(
                  tags: set.tags, counts: [:], identifierPrefix: "detail-tag",
                  hint: "Shows the library filtered by this tag", verticalInset: 0
                ) { tag in
                  model.setTagFilter(tag)
                  model.openedSets[.library] = nil
                  model.destination = .library
                }
              }
              actions(set)
                .padding(.top, 8)
              if let failure = model.setFailure {
                Text(failure.message)
                  .font(.orbis.body)
                  .foregroundStyle(OrbisColor.destructive)
                  .accessibilityIdentifier("detail-error")
              }
              if let notice = model.queueNotice {
                Text(notice)
                  .font(.orbis.body)
                  .foregroundStyle(.secondary)
                  .accessibilityIdentifier("detail-queue-notice")
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .focusSection()
          TVTracklist(model: model, set: set)
        }
        .padding(.vertical, TVLayout.liftInset)
      }
      .scrollClipDisabled()
      .background { ArtworkGlow(url: SetPresentation.pageArtwork(set)) }
      .defaultFocus($focus, isDownloading(set) ? .cancel : .play)
    }

    private func isDownloading(_ set: SavedSet) -> Bool {
      switch SetPresentation.downloadPhase(set.downloadState, live: model.audioStates[set.id]) {
      case .queued, .downloading: true
      case .available, .failed: false
      }
    }

    /// Play, and where the Set goes when it is not the one being started now. A Set whose audio
    /// is not kept offers the Download instead; the service does the work, so the TV may ask.
    @ViewBuilder private func actions(_ set: SavedSet) -> some View {
      HStack(spacing: 20) {
        if set.downloadState == "ready" {
          playButton(set)
          Button {
            Task { await model.playNext(set.id) }
          } label: {
            Label("Play Next", systemImage: "text.line.first.and.arrowtriangle.forward")
          }
          .buttonStyle(.glass)
          .accessibilityIdentifier("detail-play-next")
          Button {
            Task { await model.addToQueue(set.id) }
          } label: {
            Label("Add to Queue", systemImage: "text.line.last.and.arrowtriangle.forward")
          }
          .buttonStyle(.glass)
          .accessibilityIdentifier("detail-add-to-queue")
        } else {
          downloadButtons(set)
        }
      }
      .orbisAnimation(.downloadProgressed, value: set.downloadState == "ready")
    }

    private func playButton(_ set: SavedSet) -> some View {
      let player = model.audioPlayer
      let isCurrent = player.currentSetId == set.id
      let isPlaying = isCurrent && (player.state == .playing || player.state == .loading)
      let resumes = !isCurrent && set.playbackPositionSeconds > 0
      return Button {
        if !isCurrent {
          Task { await model.playSet(set.id) }
        } else if isPlaying {
          player.pause()
        } else {
          player.resume()
        }
      } label: {
        Label(
          isPlaying ? "Pause" : resumes ? "Resume" : "Play",
          systemImage: isPlaying ? "pause.fill" : "play.fill"
        )
        .orbisSymbolReplace()
      }
      .buttonStyle(.glassProminent)
      .tint(Color.orbis.tint)
      .focused($focus, equals: .play)
      .accessibilityIdentifier("detail-play-toggle")
    }

    /// The Download as a button the remote can press. `DownloadCapsule` answers a tap, which no
    /// remote makes, so the TV draws the same phase and words as a glass button. It stays
    /// focusable while the service works, so the progress can be read; pressing it then does
    /// nothing, and Cancel beside it is where focus starts.
    @ViewBuilder private func downloadButtons(_ set: SavedSet) -> some View {
      let phase = SetPresentation.downloadPhase(set.downloadState, live: model.audioStates[set.id])
      let isWorking = isDownloading(set)
      let label = DownloadCapsule.label(for: phase)
      Button {
        if !isWorking { Task { await model.downloadAudio(set.id) } }
      } label: {
        Label(label, systemImage: phase == .failed ? "arrow.clockwise" : "arrow.down")
          .monospacedDigit()
          .contentTransition(.numericText())
      }
      .buttonStyle(.glassProminent)
      .tint(isWorking ? Color.orbis.tint.opacity(0.5) : Color.orbis.tint)
      .focused($focus, equals: .play)
      .accessibilityValue(isWorking ? label : "")
      .accessibilityIdentifier(phase == .failed ? "detail-retry-download" : "detail-download")
      if isWorking {
        Button {
          Task { await model.cancelAudioDownload(set.id) }
        } label: {
          Label("Cancel Download", systemImage: "xmark")
        }
        .buttonStyle(.glass)
        .focused($focus, equals: .cancel)
        .accessibilityIdentifier("detail-cancel-download")
      }
    }
  }

  /// The Tracklist as focusable rows, the playing Cue marked with the bars.
  private struct TVTracklist: View {
    @Bindable var model: AppModel
    let set: SavedSet

    @ViewBuilder var body: some View {
      let tracklist = model.tracklists[set.id]
      let state = tracklist?.state ?? set.tracklistState
      switch state {
      case .ready:
        if let cues = tracklist?.cues, !cues.isEmpty {
          let selectedPosition =
            model.audioPlayer.currentSetId == set.id
            ? model.audioPlayer.currentCue?.position : nil
          LazyVStack(alignment: .leading, spacing: 8) {
            SectionHeading("Tracklist", subtitle: cues.count == 1 ? "1 track" : "\(cues.count) tracks")
              .padding(.bottom, 12)
            ForEach(cues) { cue in
              cueRow(cue, selected: cue.position == selectedPosition)
            }
          }
          .focusSection()
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("tracklist")
        }
      case .failed:
        HStack(spacing: 20) {
          Text("Tracklist unavailable")
            .foregroundStyle(.secondary)
          Button("Try again") { Task { await model.retryTracklist(set.id) } }
            .buttonStyle(.glass)
        }
        .font(.orbis.body)
        .accessibilityIdentifier("tracklist-retry")
      case .pending, .none:
        EmptyView()
      }
    }

    @ViewBuilder private func cueRow(_ cue: Cue, selected: Bool) -> some View {
      if let start = cue.startSeconds {
        Button {
          Task { await model.playCue(cue, in: set.id) }
        } label: {
          cueContent(cue, start: start, selected: selected)
        }
        .buttonStyle(.card)
        .accessibilityLabel("\(cue.title), \(cue.artist), starts at \(SetPresentation.spoken(start))")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("cue-\(cue.position)")
      } else {
        cueContent(cue, start: nil, selected: selected)
          .padding(.horizontal, 24)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(cue.title), \(cue.artist)")
          .accessibilityIdentifier("cue-\(cue.position)")
      }
    }

    private func cueContent(_ cue: Cue, start: TimeInterval?, selected: Bool) -> some View {
      HStack(spacing: 24) {
        Group {
          if selected {
            EqualizerBars(isPlaying: model.audioPlayer.state == .playing)
              .frame(height: 22)
          } else {
            Text(cue.position + 1, format: .number)
              .font(.title3)
              .monospacedDigit()
              .foregroundStyle(.secondary)
          }
        }
        .frame(minWidth: 48, alignment: .trailing)
        VStack(alignment: .leading, spacing: 2) {
          Text(cue.title)
            .font(.title3.weight(selected ? .semibold : .regular))
          Text(cue.artist)
            .font(.body)
            .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        Spacer(minLength: 0)
        Text(start.map(SetPresentation.timestamp) ?? "")
          .font(.body)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 14)
      .frame(maxWidth: .infinity)
      .orbisAnimation(.cueChanged, value: selected)
    }
  }
#endif
