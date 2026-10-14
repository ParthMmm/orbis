import OrbisDesign
import SwiftUI

/// One Set's page: what it is, where it lives, and the few things a person does to it.
///
/// The page reads the Set from the model on every pass rather than holding a copy, so an edit
/// shows up here the moment the service accepts it and a removal closes the page.
struct SetDetailScreen: View {
  @Bindable var model: AppModel
  let setId: String
  @State private var isRenaming = false

  var body: some View {
    Group {
      if let set = model.savedSet(setId) {
        SetDetail(
          title: set.title,
          source: set.source.label,
          creator: set.creator,
          showCreator: { model.showCreator(of: set) },
          length: set.durationSeconds.flatMap { $0 > 0 ? SetPresentation.length($0) : nil },
          artwork: SetPresentation.pageArtwork(set),
          failedToName: set.metadataState == "failed",
          dates: SetDetail.Dates(
            imported: SetPresentation.plainDate(set.createdAt),
            released: set.releasedAt.map(SetPresentation.plainDate)
          ),
          statistics: SetDetail.Statistics(
            listenCount: set.listenCount,
            finishCount: set.finishCount,
            lastHeard: set.lastListenedAt.map(SetPresentation.day)
          ),
          retryName: { Task { await model.nameAgain(set.id) } }
        ) {
          audioSection(set)
        } tracklist: {
          TracklistSection(model: model, set: set)
        } management: {
          SetManagementSection(model: model, set: set, isRenaming: $isRenaming)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .navigationTitle(set.title)
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("set-detail")
        .task(id: setId) {
          if set.tracklistState != .none { await model.loadTracklist(setId) }
        }
      } else {
        ContentUnavailableView {
          Label("This set is gone", systemImage: "questionmark.folder")
        } description: {
          Text("It was removed from your library.")
        }
        .accessibilityIdentifier("detail-missing")
      }
    }
    .setChangeStatus(model)
  }

  /// Download, progress, and playback for this Set. Each state shows exactly one
  /// control, so a Set that is downloading cannot also offer to play.
  private func audioSection(_ set: SavedSet) -> some View {
    // When the audio arrives the capsule grows into the player rather than being swapped for it.
    Group { audioControl(set) }
      .orbisAnimation(.downloadProgressed, value: set.downloadState == "ready")
  }

  @ViewBuilder
  private func audioControl(_ set: SavedSet) -> some View {
    switch set.downloadState {
    case "ready":
      let isCurrent = model.audioPlayer.currentSetId == set.id
      VStack(spacing: 12) {
        HStack(spacing: 12) {
          playButton(set, isCurrent: isCurrent)
          queueActions(set)
        }
        if isCurrent {
          Transport(
            player: model.audioPlayer,
            fallbackDuration: set.durationSeconds.map(TimeInterval.init),
            showsControls: false,
            cueStarts: model.tracklists[set.id]?.cues.compactMap(\.startSeconds) ?? []
          )
        } else if let left = SetPresentation.timeLeft(set) {
          Text(left)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
        }
        if let notice = model.queueNotice {
          Text(notice)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("detail-queue-notice")
        }
      }
      .transition(.opacity.combined(with: .scale(0.96, anchor: .top)))
    default:
      DownloadCapsule(
        phase: SetPresentation.downloadPhase(set.downloadState, live: model.audioStates[set.id]),
        start: { Task { await model.downloadAudio(set.id) } },
        cancel: { Task { await model.cancelAudioDownload(set.id) } }
      )
      .frame(maxWidth: .infinity)
      .transition(.opacity.combined(with: .scale(0.96, anchor: .top)))
    }
  }

  /// Play, the way an album page offers it: one wide button that starts the Set, resumes it, or
  /// pauses it when it is the one playing.
  private func playButton(_ set: SavedSet, isCurrent: Bool) -> some View {
    let player = model.audioPlayer
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
      .albumButton()
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.impact(weight: .medium), trigger: isPlaying)
    .accessibilityIdentifier("detail-play-toggle")
  }

  /// Where a Set goes when it is not the one being started now. Both actions are offered only for
  /// a Set whose audio is kept, because a Set that cannot play cannot be queued either.
  private func queueActions(_ set: SavedSet) -> some View {
    Menu {
      Button("Play Next", systemImage: "text.line.first.and.arrowtriangle.forward") {
        Task { await model.playNext(set.id) }
      }
      .accessibilityIdentifier("detail-play-next")
      Button("Add to Queue", systemImage: "text.line.last.and.arrowtriangle.forward") {
        Task { await model.addToQueue(set.id) }
      }
      .accessibilityIdentifier("detail-add-to-queue")
    } label: {
      Label("Play Next", systemImage: "text.badge.plus")
        .albumButton()
    } primaryAction: {
      Task { await model.playNext(set.id) }
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .accessibilityHint("Hold for Add to Queue")
    .accessibilityIdentifier("detail-queue-actions")
  }
}

extension View {
  /// The grey button an album page lays two of side by side, its words in the tint.
  fileprivate func albumButton() -> some View {
    font(.body.weight(.semibold))
      .foregroundStyle(Color.orbis.tint)
      .frame(maxWidth: .infinity, minHeight: 48)
      .background(Color.orbis.paperRaised, in: .rect(cornerRadius: Radius.row))
      .contentShape(.rect(cornerRadius: Radius.row))
  }
}

private struct TracklistSection: View {
  @Bindable var model: AppModel
  let set: SavedSet

  @ViewBuilder
  var body: some View {
    let tracklist = model.tracklists[set.id]
    let state = tracklist?.state ?? set.tracklistState
    switch state {
    case .ready:
      if let cues = tracklist?.cues, !cues.isEmpty {
        let selectedPosition =
          model.audioPlayer.currentSetId == set.id
          ? model.audioPlayer.currentCue?.position : nil
        VStack(alignment: .leading, spacing: 0) {
          Divider()
          ForEach(cues) { cue in
            cueRow(cue, selected: cue.position == selectedPosition)
            Divider().padding(.leading, 38)
          }
          Text(cues.count == 1 ? "1 track" : "\(cues.count) tracks")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracklist")
      }
    case .failed:
      HStack(spacing: 8) {
        Text("Tracklist unavailable")
          .foregroundStyle(.secondary)
        Button("Try again") { Task { await model.retryTracklist(set.id) } }
      }
      .font(.orbis.detail)
      .accessibilityIdentifier("tracklist-retry")
    case .pending, .none:
      EmptyView()
    }
  }

  @ViewBuilder
  private func cueRow(_ cue: Cue, selected: Bool) -> some View {
    if let start = cue.startSeconds {
      Button {
        Task { await model.playCue(cue, in: set.id) }
      } label: {
        cueContent(cue, start: start, selected: selected)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(cue.title), \(cue.artist), starts at \(SetPresentation.timestamp(start))")
      .accessibilityAddTraits(selected ? .isSelected : [])
      .accessibilityIdentifier("cue-\(cue.position)")
    } else {
      cueContent(cue, start: nil, selected: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(cue.title), \(cue.artist)")
        .accessibilityIdentifier("cue-\(cue.position)")
    }
  }

  private func cueContent(_ cue: Cue, start: TimeInterval?, selected: Bool) -> some View {
    HStack(spacing: 14) {
      Group {
        if selected {
          EqualizerBars(isPlaying: model.audioPlayer.state == .playing)
            .frame(height: 14)
        } else {
          Text(cue.position + 1, format: .number)
            .font(.body)
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
      }
      .frame(width: 24)
      VStack(alignment: .leading, spacing: 1) {
        Text(cue.title)
          .font(.body.weight(selected ? .semibold : .regular))
        Text(cue.artist)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      Text(start.map(SetPresentation.timestamp) ?? "")
        .font(.subheadline)
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
    .frame(minHeight: 54)
    .contentShape(.rect)
    .orbisAnimation(.cueChanged, value: selected)
  }

}
