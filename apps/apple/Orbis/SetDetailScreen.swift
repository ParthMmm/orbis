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
      if model.audioPlayer.currentSetId == set.id {
        Transport(
          player: model.audioPlayer,
          fallbackDuration: set.durationSeconds.map(TimeInterval.init)
        )
      } else {
        Button("Play", systemImage: "play.fill") { model.playAudio(set.id) }
          .buttonStyle(.glass)
          .controlSize(.large)
          .accessibilityIdentifier("detail-play")
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
