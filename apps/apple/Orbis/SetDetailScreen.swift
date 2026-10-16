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
            released: set.releasedAt.map(SetPresentation.plainDate),
            releaseYear: set.releasedAt.map(SetPresentation.year)
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
    let word = isPlaying ? "Pause" : resumes ? "Resume" : "Play"
    let left = resumes ? SetPresentation.timeLeft(set) : nil
    let progress = resumes ? SetPresentation.progress(set) : nil
    return Button {
      if !isCurrent {
        Task { await model.playSet(set.id) }
      } else if isPlaying {
        player.pause()
      } else {
        player.resume()
      }
    } label: {
      // The time left rides in the button it describes; it gives way first when space is short.
      ViewThatFits(in: .horizontal) {
        playLabel(word, isPlaying: isPlaying, left: left)
        playLabel(word, isPlaying: isPlaying, left: nil)
      }
      .albumButton()
      .overlay(alignment: .bottom) {
        if let progress { ResumeProgress(fraction: progress) }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(word)
    .accessibilityValue(left ?? "")
    .sensoryFeedback(.impact(weight: .medium), trigger: isPlaying)
    .accessibilityIdentifier("detail-play-toggle")
  }

  private func playLabel(_ word: String, isPlaying: Bool, left: String?) -> some View {
    HStack(spacing: 8) {
      Label(word, systemImage: isPlaying ? "pause.fill" : "play.fill")
        .orbisSymbolReplace()
      if let left {
        Text(left)
          .font(.footnote.weight(.medium))
          .foregroundStyle(Color.orbis.tint.opacity(0.7))
      }
    }
    .lineLimit(1)
    .fixedSize()
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

/// How far a paused Set got, drawn as a hairline along the foot of its Resume button.
private struct ResumeProgress: View {
  let fraction: Double

  var body: some View {
    Capsule()
      .fill(Color.orbis.tint.opacity(0.18))
      .overlay(alignment: .leading) {
        GeometryReader { proxy in
          Capsule()
            .fill(Color.orbis.tint)
            .frame(width: max(proxy.size.width * fraction, 3))
        }
      }
      .frame(height: 3)
      .padding(.horizontal, 18)
      .padding(.bottom, 7)
      .accessibilityHidden(true)
  }
}

extension View {
  /// The grey button an album page lays two of side by side, its words in the tint.
  fileprivate func albumButton() -> some View {
    font(.body.weight(.semibold))
      .foregroundStyle(Color.orbis.tint)
      // Inset, so a label that only just fits gives way to its shorter form rather than
      // running to the button's edges.
      .padding(.horizontal, 12)
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
          ? model.audioPlayer.currentCue?.position : resumeCue(in: cues)
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

  /// The cue a paused Set will resume inside, so the page shows where the person stopped.
  private func resumeCue(in cues: [Cue]) -> Int? {
    let position = TimeInterval(set.playbackPositionSeconds)
    guard position > 0 else { return nil }
    return cues.last { ($0.startSeconds ?? .infinity) <= position }?.position
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

  /// The start time follows the artist, where it reads as a place in the mix; a trailing column
  /// would read as the track's length.
  private func cueContent(_ cue: Cue, start: TimeInterval?, selected: Bool) -> some View {
    let isCurrent = model.audioPlayer.currentSetId == set.id
    return HStack(spacing: 14) {
      Group {
        if selected {
          EqualizerBars(isPlaying: isCurrent && model.audioPlayer.state == .playing)
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
        Text([cue.artist, start.map(SetPresentation.timestamp)].compactMap { $0 }.joined(separator: " · "))
          .font(.footnote)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
    }
    .frame(minHeight: 54)
    .contentShape(.rect)
    .orbisAnimation(.cueChanged, value: selected)
  }

}
