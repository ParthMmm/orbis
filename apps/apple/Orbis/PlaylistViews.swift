import OrbisDesign
import SwiftUI

/// The Playlists destination: every Playlist the library holds, and the ordered Sets inside
/// one when it is opened. Creation, renaming, deletion, membership, and reordering all live
/// here rather than behind the Library filter.
struct PlaylistsDestination: View {
  @Bindable var model: AppModel
  @State private var isCreating = false
  @State private var draftName = ""
  @State private var renamingPlaylist: Playlist?
  @State private var renameDraft = ""
  @State private var deletingPlaylist: Playlist?

  var body: some View {
    Group {
      if let id = model.openedPlaylistId, let playlist = model.playlist(id) {
        PlaylistDetailView(model: model, playlist: playlist)
      } else {
        playlistList
      }
    }
    .navigationTitle(model.openedPlaylistId == nil ? "Playlists" : "")
    .largeTitleOnIOS()
    .toolbar {
      if model.openedPlaylistId == nil {
        ToolbarItem {
          Button("New playlist", systemImage: "plus") { beginCreate() }
            .tint(Color.orbis.tint)
            .accessibilityIdentifier("playlist-create")
        }
      }
    }
    .playlistChangeStatus(model)
    .sheet(isPresented: $isCreating) { createSheet }
    .alert("Rename playlist", isPresented: renameBinding) {
      TextField("Name", text: $renameDraft)
      Button("Save") {
        guard let playlist = renamingPlaylist else { return }
        let name = renameDraft
        Task { await model.renamePlaylist(playlist.id, to: name) }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog(
      "Delete this playlist?", isPresented: deleteBinding, titleVisibility: .visible
    ) {
      Button("Delete playlist", role: .destructive) {
        guard let playlist = deletingPlaylist else { return }
        Task { await model.deletePlaylist(playlist.id) }
      }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text("The Sets stay in your Library. Only this playlist and its order are removed.")
    }
    .task {
      if model.playlists == .idle {
        await model.loadPlaylists()
      }
    }
  }

  private var playlistList: some View {
    Group {
      switch model.playlists {
      case .idle, .loading:
        LoadingState()
          .accessibilityIdentifier("playlists-loading")
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading playlists") {
          Task { await model.loadPlaylists() }
        }
        .accessibilityIdentifier("playlists-error")
      case .loaded(let items):
        if items.isEmpty {
          EmptyPlaylistState {
            beginCreate()
          }
          .accessibilityIdentifier("playlists-empty")
        } else {
          List {
            ForEach(items) { playlist in
              Button {
                model.openPlaylist(playlist.id)
                Task { await model.loadPlaylistMembers(playlist.id) }
              } label: {
                PlaylistRow(
                  playlist.name,
                  count: playlist.setCount,
                  category: SetPresentation.category(for: playlist.name)
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("playlist-row-\(playlist.name)")
              .contextMenu {
                Button("Rename", systemImage: "pencil") {
                  renamingPlaylist = playlist
                  renameDraft = playlist.name
                }
                Button("Delete", systemImage: "trash", role: .destructive) {
                  deletingPlaylist = playlist
                }
              }
            }
          }
          .accessibilityIdentifier("playlists-list")
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.orbis.paper)
  }

  private func beginCreate() {
    draftName = ""
    model.playlistFailure = nil
    isCreating = true
  }

  private var createSheet: some View {
    NavigationStack {
      Form {
        TextField("Name", text: $draftName)
          .accessibilityIdentifier("playlist-name")
      }
      .navigationTitle("New playlist")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", role: .cancel) { isCreating = false }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            let name = draftName
            Task {
              if await model.createPlaylist(named: name) != nil {
                isCreating = false
              }
            }
          }
          .disabled(model.isWorkingOnPlaylist)
          .accessibilityIdentifier("playlist-create-save")
        }
      }
    }
    .presentationDetents([.medium])
    .interactiveDismissDisabled(model.isWorkingOnPlaylist)
  }

  private var renameBinding: Binding<Bool> {
    Binding(
      get: { renamingPlaylist != nil },
      set: { if !$0 { renamingPlaylist = nil } }
    )
  }

  private var deleteBinding: Binding<Bool> {
    Binding(
      get: { deletingPlaylist != nil },
      set: { if !$0 { deletingPlaylist = nil } }
    )
  }
}

/// One Playlist's ordered members. Reorder uses the platform list, add opens the library's
/// Sets, and remove drops membership without deleting the Set.
struct PlaylistDetailView: View {
  @Bindable var model: AppModel
  let playlist: Playlist
  @State private var isAddingSets = false
  @State private var renaming = false
  @State private var renameDraft = ""
  @State private var isConfirmingDelete = false

  var body: some View {
    Group {
      switch model.playlistMembers {
      case .idle, .loading:
        LoadingState()
          .accessibilityIdentifier("playlist-members-loading")
      case .failed(let failure):
        UnavailableState(failure: failure, context: "loading this playlist") {
          Task { await model.loadPlaylistMembers(playlist.id) }
        }
        .accessibilityIdentifier("playlist-members-error")
      case .loaded(let sets):
        if sets.isEmpty {
          EmptyPlaylistState { isAddingSets = true }
            .accessibilityIdentifier("playlist-empty")
        } else {
          memberList(sets)
        }
      }
    }
    .navigationTitle(playlist.name)
    .toolbarTitleDisplayMode(.large)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button {
          model.closePlaylist()
        } label: {
          Label("Playlists", systemImage: "chevron.backward")
        }
        .accessibilityIdentifier("playlist-back")
      }
      ToolbarItemGroup {
        #if os(iOS)
          EditButton()
            .accessibilityIdentifier("playlist-edit")
        #endif
        Button("Add Sets", systemImage: "plus") { isAddingSets = true }
          .accessibilityIdentifier("playlist-add-sets")
        Menu {
          Button("Rename", systemImage: "pencil") {
            renameDraft = playlist.name
            renaming = true
          }
          Button("Delete playlist", systemImage: "trash", role: .destructive) {
            isConfirmingDelete = true
          }
        } label: {
          Label("Playlist actions", systemImage: "ellipsis.circle")
        }
        .accessibilityIdentifier("playlist-actions")
      }
    }
    .sheet(isPresented: $isAddingSets) {
      AddSetsToPlaylistSheet(model: model, playlistId: playlist.id)
    }
    .alert("Rename playlist", isPresented: $renaming) {
      TextField("Name", text: $renameDraft)
      Button("Save") {
        let name = renameDraft
        Task { await model.renamePlaylist(playlist.id, to: name) }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog(
      "Delete this playlist?", isPresented: $isConfirmingDelete, titleVisibility: .visible
    ) {
      Button("Delete playlist", role: .destructive) {
        Task { await model.deletePlaylist(playlist.id) }
      }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text("The Sets stay in your Library. Only this playlist and its order are removed.")
    }
    .task(id: playlist.id) {
      await model.loadPlaylistMembers(playlist.id)
    }
  }

  private func memberList(_ sets: [SavedSet]) -> some View {
    List {
      ForEach(sets) { set in
        let presentation = SetPresentation.row(set)
        SetRow(
          title: presentation.title,
          source: presentation.source,
          artwork: presentation.artwork,
          creator: presentation.creator,
          length: presentation.length,
          tags: presentation.tags,
          activeTag: nil,
          state: presentation.state,
          progress: presentation.progress,
          playback: SetPresentation.playback(
            of: set, currentSetId: model.audioPlayer.currentSetId,
            isPlaying: model.audioPlayer.state == .playing),
          togglePlayback: { model.togglePlayback(set.id) },
          select: { model.openSet(set.id) }
        )
        .accessibilityIdentifier("playlist-member-\(set.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          Button("Remove", role: .destructive) {
            Task { await model.removeSetFromPlaylist(playlist.id, setId: set.id) }
          }
          .accessibilityIdentifier("playlist-remove-\(set.id)")
        }
      }
      .onMove { source, destination in
        Task { await model.movePlaylistMembers(playlist.id, from: source, to: destination) }
      }
    }
    .accessibilityIdentifier("playlist-members")
  }
}

/// Every Set in the Library that is not already in the Playlist. Choosing one adds it at the
/// end, which is what a person expects when they are filling a playlist.
struct AddSetsToPlaylistSheet: View {
  @Bindable var model: AppModel
  let playlistId: String
  @Environment(\.dismiss) private var dismiss

  private var choices: [SavedSet] {
    guard case .loaded(let members) = model.playlistMembers,
      case .loaded(let library) = model.library
    else { return [] }
    let memberIds = Set(members.map(\.id))
    return library.filter { !memberIds.contains($0.id) }
  }

  var body: some View {
    NavigationStack {
      Group {
        if choices.isEmpty {
          NoResultsState(recoverLabel: "Done", recover: { dismiss() })
        } else {
          List(choices) { set in
            Button {
              Task {
                await model.addSetToPlaylist(playlistId, setId: set.id)
                dismiss()
              }
            } label: {
              Text(set.title)
                .font(.orbis.rowTitle)
            }
            .accessibilityIdentifier("playlist-add-\(set.id)")
          }
        }
      }
      .navigationTitle("Add Sets")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", role: .close) { dismiss() }
        }
      }
    }
    .task {
      if case .idle = model.library {
        await model.loadLibrary()
      }
    }
  }
}

/// What the last Playlist change left behind, shown where the action was taken.
struct PlaylistChangeStatus: ViewModifier {
  let model: AppModel

  func body(content: Content) -> some View {
    content.overlay(alignment: .bottom) {
      if let failure = model.playlistFailure {
        VStack(alignment: .leading, spacing: 6) {
          Text(failure.message)
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("playlist-error")
          CopyFailureButton(
            report: FailureReport(failure: failure, context: "changing a playlist"))
        }
        .padding()
        .orbisRaised(radius: Radius.row)
        .padding()
      } else if model.isWorkingOnPlaylist {
        HStack(spacing: 8) {
          ProgressView()
          Text("Saving")
            .font(.orbis.mono)
            .foregroundStyle(.secondary)
        }
        .padding()
        .orbisRaised(radius: Radius.row)
        .padding()
        .accessibilityIdentifier("playlist-saving")
      }
    }
  }
}

extension View {
  fileprivate func playlistChangeStatus(_ model: AppModel) -> some View {
    modifier(PlaylistChangeStatus(model: model))
  }
}
