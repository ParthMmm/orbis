import OrbisDesign
import SwiftUI

/// One Set's page: what it is, where it lives, and the few things a person does to it.
///
/// The page reads the Set from the model on every pass rather than holding a copy, so an edit
/// shows up here the moment the service accepts it and a removal closes the page.
struct SetDetailScreen: View {
  @Bindable var model: AppModel
  let setId: String

  var body: some View {
    Group {
      if let set = model.savedSet(setId) {
        SetDetail(
          title: set.title,
          source: set.source.label,
          subtitle: SetPresentation.subtitle(set),
          artwork: SetPresentation.pageArtwork(set),
          position: model.audioPlayer.currentSetId == set.id
            ? nil : SetPresentation.playbackPosition(set),
          progress: SetPresentation.progress(of: set),
          failedToName: set.metadataState == "failed",
          statistics: SetDetail.Statistics(
            listenCount: set.listenCount,
            finishCount: set.finishCount,
            lastHeard: set.lastListenedAt.map(SetPresentation.day)
          ),
          retryName: { Task { await model.nameAgain(set.id) } }
        ) {
          audioSection(set)
        } management: {
          SetManagementSection(model: model, set: set)
        }
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
      VStack(alignment: .leading, spacing: 8) {
        if model.audioPlayer.currentSetId == set.id {
          Transport(
            player: model.audioPlayer,
            fallbackDuration: set.durationSeconds.map(TimeInterval.init)
          )
        } else {
          HStack(spacing: 8) {
            Button("Play", systemImage: "play.fill") { Task { await model.playSet(set.id) } }
              .buttonStyle(.glass)
              .controlSize(.large)
              .accessibilityIdentifier("detail-play")
            queueActions(set)
          }
        }
        if let notice = model.queueNotice {
          Text(notice)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("detail-queue-notice")
        }
      }
    case "queued", "downloading":
      // The watch that turns this into a finished download belongs to the model: a task started
      // here would end when the person leaves, which is when the Library still needs the answer.
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          ProgressView()
          Text(progressLabel(set))
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        Button("Cancel", role: .cancel) {
          Task { await model.cancelAudioDownload(set.id) }
        }
      }
    default:
      Button(
        set.downloadState == "failed" || set.downloadState == "canceled"
          ? "Retry download" : "Download",
        systemImage: set.downloadState == "failed" || set.downloadState == "canceled"
          ? "arrow.clockwise" : "arrow.down.circle"
      ) {
        Task { await model.downloadAudio(set.id) }
      }
      .buttonStyle(.glass)
      .controlSize(.large)
      .accessibilityIdentifier(
        set.downloadState == "failed" || set.downloadState == "canceled"
          ? "detail-retry-download" : "detail-download"
      )
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
    .buttonStyle(.glass)
    .controlSize(.large)
    .accessibilityLabel("Queue this set")
    .accessibilityIdentifier("detail-queue-actions")
  }

  private func progressLabel(_ set: SavedSet) -> String {
    if let progress = model.audioStates[set.id], let total = progress.bytesTotal,
      total > 0
    {
      let percent = min(progress.bytesReceived * 100 / total, 100)
      return "Downloading \(percent)%"
    }
    return SetPresentation.downloadLabel(set.downloadState) ?? "Downloading"
  }
}
