import OrbisDesign
import SwiftUI

/// How a Set is changed, and the sheets those changes open. The page shows the Tags; the rest —
/// the title, the Playlist, the source, removal — sits in the toolbar, as one source button and
/// one menu, the way a music app keeps an album's actions behind one button. The Set's page and
/// the Now Playing screen both carry it, so a Set is managed the same way wherever it is met,
/// and every change reports through the model's one `setFailure`.
///
/// The section reads the Set from the model on every pass rather than holding a copy, so an
/// edit shows up the moment the service accepts it.
struct SetManagementSection: View {
  @Bindable var model: AppModel
  let set: SavedSet
  /// Owned by the screen, so the sheet survives the section being rebuilt.
  @Binding var isRenaming: Bool

  @Environment(\.openURL) private var openURL
  @State private var isEditingTags = false
  @State private var isConfirmingRemoval = false
  @State private var isAddingToPlaylist = false

  var body: some View {
    SetManagement(
      tags: set.tags,
      category: SetPresentation.category(for:),
      editTags: { isEditingTags = true }
    )
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button("Open in \(set.source.label)", systemImage: SetPresentation.sourceSymbol(set.source)) {
          open()
        }
        .accessibilityIdentifier("detail-open")
        actions
      }
    }
    .sheet(isPresented: $isRenaming) {
      RenameSheet(title: set.title) { title in
        Task { await model.rename(set.id, to: title) }
      }
    }
    .sheet(isPresented: $isAddingToPlaylist) {
      AddToPlaylistSheet(model: model, set: set)
    }
    .sheet(isPresented: $isEditingTags) {
      TagSheet(tags: set.tags, suggestions: model.availableTags) { tags in
        Task { await model.replaceTags(set.id, with: tags) }
      }
    }
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

  /// Everything else a Set is changed with, behind one button.
  private var actions: some View {
    Menu {
      Button("Rename", systemImage: "pencil") { isRenaming = true }
        .accessibilityIdentifier("detail-rename-action")
      Button("Add to Playlist", systemImage: "text.badge.plus") { isAddingToPlaylist = true }
        .accessibilityIdentifier("detail-playlist")
      Button("Open in \(set.source.label)", systemImage: SetPresentation.sourceSymbol(set.source)) {
        open()
      }
      if let link = SetPresentation.sourceURL(set) {
        ShareLink(item: link, subject: Text(set.title)) {
          Label("Share", systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("detail-share")
      }
      Divider()
      Button("Remove from Library", systemImage: "trash", role: .destructive) {
        isConfirmingRemoval = true
      }
      .accessibilityIdentifier("detail-remove")
    } label: {
      Label("More", systemImage: "ellipsis")
    }
    .accessibilityIdentifier("detail-actions")
  }

  private var removalMessage: String {
    let notice = SetManagement.removalNotice(retainedAudio: retainedAudio)
    return [notice.scope, notice.retained].compactMap { $0 }.joined(separator: " ")
  }

  private var retainedAudio: Bool {
    // Qualified, because a body that opens with `set` reads as a setter.
    self.set.downloadState == "ready"
  }

  private func open() {
    guard let url = SetPresentation.sourceURL(set) else { return }
    openURL(url)
  }
}

/// Renaming a Set: one field in a small sheet, saved from the toolbar.
private struct RenameSheet: View {
  let save: (String) -> Void
  @State private var draft: String
  @Environment(\.dismiss) private var dismiss
  @FocusState private var focused: Bool

  init(title: String, save: @escaping (String) -> Void) {
    self.save = save
    _draft = State(initialValue: title)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Title", text: $draft, axis: .vertical)
            .focused($focused)
            .onSubmit(commit)
            .accessibilityIdentifier("rename-title")
        } footer: {
          Text("The service keeps 200 characters.")
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Rename")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .close) { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save", systemImage: "checkmark", role: .confirm, action: commit)
            .tint(Color.orbis.tint)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("rename-save")
        }
      }
      .onAppear { focused = true }
    }
    .presentationDetents([.medium])
  }

  private func commit() {
    let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return }
    save(title)
    dismiss()
  }
}

/// Changing a Set's Tags, in the same shape of sheet as renaming it.
private struct TagSheet: View {
  let suggestions: [String]
  let save: ([String]) -> Void
  @State private var draft: [String]
  @Environment(\.dismiss) private var dismiss

  init(tags: [String], suggestions: [String], save: @escaping ([String]) -> Void) {
    self.suggestions = suggestions
    self.save = save
    _draft = State(initialValue: tags)
  }

  var body: some View {
    NavigationStack {
      Form {
        TagListEditor(tags: $draft, suggestions: suggestions, category: SetPresentation.category(for:))
      }
      .formStyle(.grouped)
      .navigationTitle("Tags")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .close) { dismiss() }
            .accessibilityIdentifier("tags-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark", role: .confirm) {
            save(draft)
            dismiss()
          }
          .tint(Color.orbis.tint)
          // Plain Return belongs to the Tag field, which adds a Tag with it, so this takes the
          // modified key instead.
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityIdentifier("tags-done")
        }
      }
    }
    .presentationDetents([.medium, .large])
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
            .font(.orbis.detail)
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
            .font(.orbis.detail)
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
