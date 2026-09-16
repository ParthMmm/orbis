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

  var body: some View {
    Group {
      if let set = model.savedSet(setId) {
        SetDetail(
          title: set.title,
          source: set.source.label,
          subtitle: SetPresentation.subtitle(set),
          artwork: set.artworkUrl.flatMap(URL.init(string:)),
          tags: set.tags,
          position: model.audioPlayer.currentSetId == set.id
            ? nil : SetPresentation.playbackPosition(set),
          progress: SetPresentation.progress(of: set),
          failedToName: set.metadataState == "failed",
          retainedAudio: set.downloadState == "ready",
          playlistId: playlistBinding(set),
          playlists: playlistChoices,
          open: { open(set) },
          retryName: { Task { await model.nameAgain(set.id) } },
          rename: { startRenaming(set) },
          editTags: { startEditingTags(set) },
          remove: { isConfirmingRemoval = true }
        ) {
          audioSection(set)
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
      Button("Download", systemImage: "arrow.down.circle") {
        Task { await model.downloadAudio(set.id) }
      }
      .buttonStyle(.glass)
      .controlSize(.large)
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

  @ViewBuilder
  private func playerControls(_ set: SavedSet) -> some View {
    let player = model.audioPlayer
    // The bar takes the whole width on its own line, the way a music app lays it out: a Set
    // runs an hour or more, and every point of width is seconds of precision. The clock sits
    // under its ends, and the skips beside Play are the fine control the bar cannot give.
    VStack(alignment: .leading, spacing: 16) {
      if let duration = player.duration ?? set.durationSeconds.map(TimeInterval.init) {
        PlaybackProgress(player: player, duration: duration)
      } else {
        ProgressView()
          .frame(maxWidth: .infinity)
      }
      HStack {
        Button("Back 15 seconds", systemImage: "gobackward.15") {
          player.seek(to: player.elapsed - 15)
        }
        .accessibilityIdentifier("detail-back")
        Spacer()
        Button(
          player.state == .playing ? "Pause" : "Play",
          systemImage: player.state == .playing ? "pause.fill" : "play.fill"
        ) {
          if player.state == .playing {
            player.pause()
          } else {
            player.resume()
          }
        }
        .buttonStyle(.glassProminent)
        .tint(Color.orbis.tint)
        .controlSize(.extraLarge)
        .accessibilityIdentifier("detail-play-toggle")
        Spacer()
        Button("Forward 30 seconds", systemImage: "goforward.30") {
          player.seek(to: player.elapsed + 30)
        }
        .accessibilityIdentifier("detail-forward")
      }
      .buttonStyle(.plain)
      .labelStyle(.iconOnly)
      .font(.title2)
      .padding(.horizontal, 24)
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
        // Plain Return belongs to the Tag field, which adds a Tag with it, so this takes the
        // modified key instead.
        .keyboardShortcut(.return, modifiers: .command)
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

/// The seek bar and the clock for it, in their own view because the player publishes elapsed time
/// twice a second and SwiftUI redraws the body that read the value. From the page's own body that
/// was the whole page, tag chips and Playlist picker included, on every tick.
private struct PlaybackProgress: View {
  let player: AudioPlayer
  let duration: TimeInterval

  /// Where the person has dragged to but not let go of. Nil is following the player.
  @State private var scrubPosition: TimeInterval?

  /// The position the bar shows and the person sets: the drag they are holding, or the player's
  /// own elapsed time while they are not.
  private var position: Binding<TimeInterval> {
    Binding(
      get: { scrubPosition ?? player.elapsed },
      set: { scrubPosition = $0 }
    )
  }

  var body: some View {
    let shown = scrubPosition ?? player.elapsed
    VStack(spacing: 4) {
      Slider(
        value: position,
        in: 0...max(duration, 1),
        onEditingChanged: { editing in
          if !editing, let position = scrubPosition {
            player.seek(to: position)
            scrubPosition = nil
          }
        }
      )
      .accessibilityIdentifier("detail-seek")
      .accessibilityValue(SetPresentation.timestamp(shown))
      // Elapsed under the left end, what is left under the right, the way a deck reads.
      HStack {
        Text(SetPresentation.timestamp(shown))
        Spacer()
        Text("-\(SetPresentation.timestamp(max(duration - shown, 0)))")
      }
      .font(.orbis.mono)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
  }
}
