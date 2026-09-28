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
        } management: {
          SetManagementSection(model: model, set: set, isRenaming: $isRenaming)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .navigationTitle(set.title)
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("set-detail")
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
  @ViewBuilder
  private func audioSection(_ set: SavedSet) -> some View {
    switch set.downloadState {
    case "ready":
      VStack(spacing: 8) {
        Transport(
          player: model.audioPlayer,
          fallbackDuration: set.durationSeconds.map(TimeInterval.init),
          isCurrent: model.audioPlayer.currentSetId == set.id,
          savedPosition: TimeInterval(set.playbackPositionSeconds),
          start: { Task { await model.playSet(set.id) } },
          leading: AnyView(queueActions(set)),
          trailing: AnyView(AirPlayButton())
        )
        if let notice = model.queueNotice {
          Text(notice)
            .font(.orbis.detail)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("detail-queue-notice")
        }
      }
    default:
      DownloadCapsule(
        phase: downloadPhase(set),
        start: { Task { await model.downloadAudio(set.id) } },
        cancel: { Task { await model.cancelAudioDownload(set.id) } }
      )
      .frame(maxWidth: .infinity)
    }
  }

  private func downloadPhase(_ set: SavedSet) -> DownloadCapsule.Phase {
    switch set.downloadState {
    case "queued":
      return .queued
    case "downloading":
      guard let progress = model.audioStates[set.id], let total = progress.bytesTotal, total > 0
      else { return .downloading(nil) }
      return .downloading(Double(progress.bytesReceived) / Double(total))
    case "failed", "canceled":
      return .failed
    default:
      return .available
    }
  }

  /// Where a Set goes when it is not the one being started now. Both actions are offered only for
  /// a Set whose audio is kept, because a Set that cannot play cannot be queued either.
  private func queueActions(_ set: SavedSet) -> some View {
    Menu {
      Button("Play next") { Task { await model.playNext(set.id) } }
        .accessibilityIdentifier("detail-play-next")
      Button("Add to queue") { Task { await model.addToQueue(set.id) } }
        .accessibilityIdentifier("detail-add-to-queue")
    } label: {
      Image(systemName: "text.badge.plus")
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .accessibilityLabel("Queue this set")
    .accessibilityIdentifier("detail-queue-actions")
  }

}
