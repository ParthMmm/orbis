import OrbisDesign
import SwiftUI

/// The section reads the Set from the model on every pass rather than holding a copy, so an
/// edit shows up the moment the service accepts it.
struct SetManagementSection: View {
  @Bindable var model: AppModel
  let set: SavedSet
  @Binding var isRenaming: Bool
  var style: Style = .page

  /// `.page` shows the Tags and puts the menu in the toolbar; `.inline` is the
  /// menu alone, as one button, for Now Playing.
  enum Style {
    case page
    case inline
  }

  @Environment(\.openURL) private var openURL
  @State private var isEditingTags = false
  @State private var isConfirmingRemoval = false
  @State private var isAddingToPlaylist = false

  var body: some View {
    content
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

  @ViewBuilder private var content: some View {
    switch style {
    case .page:
      SetManagement(
        tags: set.tags,
        category: SetPresentation.category(for:),
        showTag: { model.showTag($0) },
        editTags: { isEditingTags = true }
      )
      .toolbar {
        ToolbarItem(placement: .primaryAction) { actions }
      }
    case .inline:
      actions
        .buttonStyle(.plain)
    }
  }

  private var actions: some View {
    Menu {
      Button(set.tags.isEmpty ? "Add Tags" : "Edit Tags", systemImage: "tag") {
        isEditingTags = true
      }
      .accessibilityIdentifier("detail-edit-tags")
      Button("Rename", systemImage: "pencil") { isRenaming = true }
        .accessibilityIdentifier("detail-rename-action")
      Button("Add to Playlist", systemImage: "text.badge.plus") { isAddingToPlaylist = true }
        .accessibilityIdentifier("detail-playlist")
      Button("Open in \(set.source.label)", systemImage: SetPresentation.sourceSymbol(set.source)) {
        open()
      }
      .accessibilityIdentifier("detail-open")
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
      if style == .inline {
        // Glass drawn on the label, not by a glass button style, which pads the circle past 44.
        Label("More", systemImage: "ellipsis")
          .labelStyle(.iconOnly)
          .font(.title3.weight(.semibold))
          .frame(width: 44, height: 44)
          .glassEffect(.regular.interactive(), in: .circle)
      } else {
        Label("More", systemImage: "ellipsis")
      }
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

struct TagSheet: View {
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
          .keyboardShortcut(.return, modifiers: .command)
          .accessibilityIdentifier("tags-done")
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

/// One Tag at a time, put on or taken off every selected Set. A Tag shows whether all, some, or
/// none of the Sets carry it, and a tap makes it all, unless all already carry it.
struct BulkTagSheet: View {
  @Bindable var model: AppModel
  let ids: [String]
  @State private var draft = ""
  @Environment(\.dismiss) private var dismiss

  private enum Coverage {
    case all, some, none
  }

  private func coverage(of tag: String) -> Coverage {
    let carrying = ids.count { model.savedSet($0)?.tags.contains(tag) == true }
    return carrying == ids.count ? .all : carrying == 0 ? .none : .some
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("New Tag", text: $draft)
            .onSubmit(create)
            .autocorrectionDisabled()
            #if os(iOS)
              .textInputAutocapitalization(.never)
            #endif
            .accessibilityIdentifier("bulk-tag-field")
        }
        if !model.availableTags.isEmpty {
          Section("Tags") {
            GlassEffectContainer(spacing: 8) {
              ChipFlow(spacing: 8) {
                ForEach(model.availableTags, id: \.self) { tag in
                  chip(tag, coverage: coverage(of: tag))
                }
              }
            }
            .padding(.vertical, 4)
            // One write at a time: each reads the Tags the last one left.
            .disabled(model.isWorkingOnSet)
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(ids.count == 1 ? "Tag 1 Set" : "Tag \(ids.count) Sets")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark", role: .confirm) { dismiss() }
            .tint(Color.orbis.tint)
            .accessibilityIdentifier("bulk-tag-done")
        }
      }
      .setChangeStatus(model)
    }
    .presentationDetents([.medium, .large])
  }

  private func chip(_ tag: String, coverage: Coverage) -> some View {
    Button {
      Task { await model.setTag(tag, on: ids, to: coverage != .all) }
    } label: {
      GlassTagChip(
        tag, category: SetPresentation.category(for: tag), selected: coverage == .all,
        accessory: coverage == .all ? "checkmark" : coverage == .some ? "minus" : "plus")
    }
    .buttonStyle(.plain)
    .accessibilityValue(
      coverage == .all ? "On every set" : coverage == .some ? "On some sets" : "On no sets"
    )
    .accessibilityIdentifier("bulk-tag-\(tag)")
  }

  private func create() {
    let tag = draft
    draft = ""
    Task { await model.setTag(tag, on: ids, to: true) }
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
