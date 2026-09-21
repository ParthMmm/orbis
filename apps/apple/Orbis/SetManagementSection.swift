import OrbisDesign
import SwiftUI

/// The rows a Set is changed with, and the alerts and sheets those changes open. The Set's
/// page and the Now Playing screen both carry it, so a Set is managed the same way wherever
/// it is met, and every change reports through the model's one `setFailure`.
///
/// The section reads the Set from the model on every pass rather than holding a copy, so an
/// edit shows up the moment the service accepts it.
struct SetManagementSection: View {
  @Bindable var model: AppModel
  let set: SavedSet

  @Environment(\.openURL) private var openURL
  @State private var isRenaming = false
  @State private var draftTitle = ""
  @State private var isEditingTags = false
  @State private var draftTags: [String] = []
  @State private var isConfirmingRemoval = false

  var body: some View {
    SetManagement(
      title: set.title,
      source: set.source.label,
      tags: set.tags,
      retainedAudio: retainedAudio,
      playlistId: playlistBinding,
      playlists: playlistChoices,
      open: open,
      rename: startRenaming,
      editTags: startEditingTags,
      remove: { isConfirmingRemoval = true }
    )
    .alert("Title", isPresented: $isRenaming) {
      TextField("Title", text: $draftTitle)
      Button("Save") {
        let title = draftTitle
        Task { await model.rename(set.id, to: title) }
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
        Task { await model.remove(set.id) }
      }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text(removalMessage)
    }
  }

  private var removalMessage: String {
    let notice = SetManagement.removalNotice(retainedAudio: retainedAudio)
    return notice.retained ?? notice.scope
  }

  private var retainedAudio: Bool {
    // Qualified, because a body that opens with `set` reads as a setter.
    self.set.downloadState == "ready"
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
  private var playlistBinding: Binding<String?> {
    Binding(
      get: { model.savedSet(set.id)?.playlistIds.first },
      set: { chosen in Task { await model.move(set.id, to: chosen) } }
    )
  }

  private func open() {
    guard let url = SetPresentation.sourceURL(set) else { return }
    openURL(url)
  }

  private func startRenaming() {
    draftTitle = set.title
    isRenaming = true
  }

  private func startEditingTags() {
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
          Task { await model.replaceTags(set.id, with: tags) }
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

/// What the last change from the management rows left behind, pinned to the bottom of the
/// screen: the refusal, readable where the action was taken, or the wait, so the five writes
/// a Set takes never leave the screen looking idle, which reads as a tap that did nothing.
struct SetChangeStatus: ViewModifier {
  let model: AppModel

  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
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
  }
}

extension View {
  func setChangeStatus(_ model: AppModel) -> some View {
    modifier(SetChangeStatus(model: model))
  }
}
