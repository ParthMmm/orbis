import OrbisDesign
import SwiftUI

/// One Set's page: what it is, where it lives, and the few things a person does to it.
///
/// The page reads the Set from the model on every pass rather than holding a copy, so an edit
/// shows up here the moment the service accepts it and a removal closes the page.
struct SetDetailScreen: View {
  @Bindable var model: AppModel
  let setId: String

  @Environment(\.openURL) private var openURL
  @State private var isRenaming = false
  @State private var draftTitle = ""
  @State private var isEditingTags = false
  @State private var draftTags: [String] = []
  @State private var isConfirmingRemoval = false
  @State private var scrubPosition: TimeInterval?

  var body: some View {
    Group {
      if let set = model.savedSet(setId) {
        SetDetail(
          title: set.title,
          source: set.source.label,
          subtitle: SetPresentation.subtitle(set),
          tags: set.tags,
          position: SetPresentation.playbackPosition(set),
          failedToName: set.metadataState == "failed",
          retainedAudio: set.downloadState == "ready",
          playlistId: playlistBinding(set),
          playlists: playlistChoices,
          open: { open(set) },
          retryName: { Task { await model.nameAgain(set.id) } },
          rename: { startRenaming(set) },
          editTags: { startEditingTags(set) },
          remove: { isConfirmingRemoval = true }
        )
        .navigationTitle(set.title)
        .accessibilityIdentifier("set-detail")
        audioSection(set)
      } else {
        ContentUnavailableView {
          Label("This set is gone", systemImage: "questionmark.folder")
        } description: {
          Text("It was removed from your library.")
        }
        .accessibilityIdentifier("detail-missing")
      }
    }
    .overlay(alignment: .bottom) {
      if let failure = model.setFailure {
        VStack(alignment: .leading, spacing: 6) {
          Text(failure.message)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("detail-error")
          CopyFailureButton(
            report: FailureReport(failure: failure, context: "changing a set"))
        }
        .padding()
        .orbisRaised(radius: Radius.row)
        .padding()
      } else if model.isWorkingOnSet {
        // The five writes a page can make otherwise leave the screen looking idle, which
        // reads as a tap that did nothing.
        HStack(spacing: 8) {
          ProgressView()
          Text("Saving")
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        .padding()
        .orbisRaised(radius: Radius.row)
        .padding()
        .accessibilityIdentifier("detail-saving")
      }
    }
    .alert("Title", isPresented: $isRenaming) {
      TextField("Title", text: $draftTitle)
      Button("Save") {
        let title = draftTitle
        Task { await model.rename(setId, to: title) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The service keeps 200 characters.")
    }
    .sheet(isPresented: $isEditingTags) { tagEditor }
    .confirmationDialog(
      "Remove this set?", isPresented: $isConfirmingRemoval, titleVisibility: .visible
    ) {
      Button("Remove from library", role: .destructive) {
        Task { await model.remove(setId) }
      }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text(removalMessage)
    }
  }

  private var removalMessage: String {
    let notice = SetDetail.removalNotice(retainedAudio: retainedAudio)
    return notice.retained ?? notice.scope
  }

  private var retainedAudio: Bool {
    model.savedSet(setId)?.downloadState == "ready"
  }

  /// Download, progress, and playback for this Set. Each state shows exactly one
  /// control, so a Set that is downloading cannot also offer to play.
  @ViewBuilder
  private func audioSection(_ set: SavedSet) -> some View {
    switch set.downloadState {
    case "ready":
      if model.audioPlayer.currentSetId == set.id {
        playerControls(set)
      } else {
        Button("Play") { model.playAudio(set.id) }
          .accessibilityIdentifier("detail-play")
      }
    case "queued", "downloading":
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
      .task(id: set.downloadState) { await pollAudio(set.id) }
    default:
      Button("Download") { Task { await model.downloadAudio(set.id) } }
        .accessibilityIdentifier("detail-download")
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

  private func pollAudio(_ id: String) async {
    while ["queued", "downloading"].contains(model.savedSet(id)?.downloadState ?? "none") {
      await model.refreshAudioState(id)
      try? await Task.sleep(for: .seconds(1))
    }
  }

  @ViewBuilder
  private func playerControls(_ set: SavedSet) -> some View {
    let player = model.audioPlayer
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        Button(player.state == .playing ? "Pause" : "Play") {
          if player.state == .playing {
            player.pause()
          } else {
            player.resume()
          }
        }
        .accessibilityIdentifier("detail-play-toggle")
        if let duration = player.duration ?? set.durationSeconds.map(TimeInterval.init) {
          Slider(
            value: Binding(
              get: { scrubPosition ?? player.elapsed },
              set: { scrubPosition = $0 }
            ),
            in: 0...max(duration, 1),
            onEditingChanged: { editing in
              if !editing, let position = scrubPosition {
                player.seek(to: position)
                scrubPosition = nil
              }
            }
          )
          .accessibilityIdentifier("detail-seek")
          Text(
            "\(SetPresentation.timestamp(scrubPosition ?? player.elapsed)) / \(SetPresentation.timestamp(duration))"
          )
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
        } else {
          ProgressView()
        }
      }
      if case .failed(let message) = player.state {
        Text(message)
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
      if case .loading = player.state {
        Text("Loading audio")
          .font(.orbis.mono)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var playlistChoices: [PlaylistPicker.Choice] {
    model.playlistItems.map { playlist in
      PlaylistPicker.Choice(
        id: playlist.id,
        name: playlist.name,
        category: SetPresentation.category(for: playlist.name)
      )
    }
  }

  /// The picker shows the Playlist the Set is in and moves it on a choice, so the write goes
  /// out the moment a person decides rather than behind a Save button.
  private func playlistBinding(_ set: SavedSet) -> Binding<String?> {
    Binding(
      get: { model.savedSet(set.id)?.playlistIds.first },
      set: { chosen in Task { await model.move(set.id, to: chosen) } }
    )
  }

  private func open(_ set: SavedSet) {
    guard let url = SetPresentation.sourceURL(set) else { return }
    openURL(url)
  }

  private func startRenaming(_ set: SavedSet) {
    draftTitle = set.title
    isRenaming = true
  }

  private func startEditingTags(_ set: SavedSet) {
    draftTags = set.tags
    isEditingTags = true
  }

  private var tagEditor: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Tags")
        .font(.orbis.sectionTitle)
      TagInput(tags: $draftTags, suggestions: model.availableTags)
      HStack {
        Button("Done") {
          isEditingTags = false
          let tags = draftTags
          Task { await model.replaceTags(setId, with: tags) }
        }
        .buttonStyle(OrbisPrimaryButtonStyle())
        .accessibilityIdentifier("tags-done")
        Button("Cancel") { isEditingTags = false }
          .buttonStyle(.plain)
          .accessibilityIdentifier("tags-cancel")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding()
    .background(Color.orbis.paper)
    #if os(iOS)
      .presentationDetents([.medium])
    #endif
  }
}
