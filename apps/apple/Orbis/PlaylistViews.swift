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
  @State private var playlistQuery = ""

  var body: some View {
    Group {
      if let id = model.openedPlaylistId, let playlist = model.playlist(id) {
        PlaylistDetailView(model: model, playlist: playlist)
      } else {
        playlistList
      }
    }
    .sidebarPageTitle(model.openedPlaylistId == nil ? "Playlists" : "")
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
      // The folders show their Sets' artwork, which the Library holds.
      if case .idle = model.library {
        await model.loadLibrary()
      }
    }
  }

  /// The artwork of a Playlist's Sets, in Library order, for its folder.
  private func artwork(of playlist: Playlist) -> [URL?] {
    guard case .loaded(let sets) = model.library else { return [] }
    return sets.filter { $0.playlistIds.contains(playlist.id) }
      .prefix(3).map { SetPresentation.row($0).artwork }
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
          NoPlaylistsState {
            beginCreate()
          }
          .accessibilityIdentifier("playlists-empty")
        } else {
          playlistGrid(matchingPlaylists(items))
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background {
      ArtworkGlow(url: model.playlistItems.first.flatMap { artwork(of: $0).first ?? nil }, reach: 0.55)
    }
    .largeTitleOnIOS()
    .macPageSearch(text: $playlistQuery, prompt: "Find in Playlists")
    .macSearchToolbarBackground(isSearching: !playlistQuery.isEmpty)
  }

  /// Every Playlist as a folder with its Sets' artwork fanned out of it, and a last tile that
  /// starts a new one.
  private func playlistGrid(_ items: [Playlist]) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        MacPageTitle.slot("Playlists")
        Text("Your sets, sorted for the moment.")
          .font(.orbis.detail)
          .foregroundStyle(.secondary)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 14)], spacing: 22) {
          ForEach(items) { playlist in
            Button {
              model.openPlaylist(playlist.id)
              Task { await model.loadPlaylistMembers(playlist.id) }
            } label: {
              PlaylistSleeve(
                name: playlist.name,
                count: playlist.setCount,
                artwork: artwork(of: playlist),
                category: SetPresentation.category(for: playlist.name)
              )
            }
            .buttonStyle(.orbisPressable)
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
          Button(action: beginCreate) {
            VStack(spacing: 8) {
              Image(systemName: "plus")
                .font(.title2.weight(.semibold))
              Text("New playlist")
                .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(Color.orbis.tint)
            .frame(maxWidth: .infinity, minHeight: 150)
            .background(
              Color.orbis.paperRaised.opacity(0.6), in: .rect(cornerRadius: 20)
            )
            .overlay {
              RoundedRectangle(cornerRadius: 20)
                .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
            }
            .contentShape(.rect(cornerRadius: 20))
          }
          .buttonStyle(.orbisPressable)
          .accessibilityIdentifier("playlist-create-tile")
        }
      }
      .padding()
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("playlists-list")
  }

  private func matchingPlaylists(_ items: [Playlist]) -> [Playlist] {
    guard !playlistQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return items
    }
    return items.filter { $0.name.localizedCaseInsensitiveContains(playlistQuery) }
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
  /// The play a person asked for while something else was playing, held until they confirm.
  @State private var pendingPlay: PlayOrder?

  private enum PlayOrder {
    case inOrder
    case shuffled
  }

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
    .toolbarTitleDisplayMode(.inline)
    .background {
      ArtworkGlow(url: members.first.map { SetPresentation.row($0).artwork } ?? nil, reach: 0.6)
    }
    .confirmationDialog(
      "Play this playlist?", isPresented: isConfirmingPlayBinding, titleVisibility: .visible
    ) {
      Button("Replace the queue") { startPlayback() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This replaces what is playing now.")
    }
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

  private var members: [SavedSet] {
    if case .loaded(let sets) = model.playlistMembers { sets } else { [] }
  }

  private var isConfirmingPlayBinding: Binding<Bool> {
    Binding(get: { pendingPlay != nil }, set: { if !$0 { pendingPlay = nil } })
  }

  /// Plays now, or asks first when something else is playing, since either way the queue is
  /// replaced.
  private func play(shuffled: Bool) {
    pendingPlay = shuffled ? .shuffled : .inOrder
    if !model.isPlayingNow { startPlayback() }
  }

  private func startPlayback() {
    let order = pendingPlay
    pendingPlay = nil
    Task {
      if order == .shuffled {
        await model.shufflePlaylist(playlist.id)
      } else {
        await model.playPlaylist(playlist.id)
      }
    }
  }

  /// The Playlist, large: its Sets' artwork fanned out, its name and length, and the two ways to
  /// play it.
  private func hero(_ sets: [SavedSet]) -> some View {
    let seconds = sets.compactMap(\.durationSeconds).reduce(0, +)
    let count = sets.count == 1 ? "1 set" : "\(sets.count) sets"
    // On a Mac the fan sits beside the name and the buttons, as Home's hero does.
    return HeroLayout.stack(spacing: 14) {
      SleeveFan(
        seed: playlist.name,
        artwork: sets.prefix(3).map { SetPresentation.row($0).artwork },
        category: SetPresentation.category(for: playlist.name),
        width: HeroLayout.isBeside ? 220 : 200
      )
      .frame(height: HeroLayout.isBeside ? 170 : 150)
      VStack(alignment: HeroLayout.alignment, spacing: 14) {
        VStack(alignment: HeroLayout.alignment, spacing: 5) {
          Eyebrow("Playlist")
          Text(playlist.name)
            .font(HeroLayout.isBeside ? Font.orbis.largeTitle : Font.orbis.title)
            .multilineTextAlignment(HeroLayout.textAlignment)
            .accessibilityAddTraits(.isHeader)
          Text(seconds > 0 ? "\(count) · \(SetPresentation.length(seconds))" : count)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        playButtons
      }
      .frame(maxWidth: HeroLayout.isBeside ? CGFloat.infinity : nil, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: HeroLayout.frameAlignment)
    .padding(.vertical, 8)
  }

  private var playButtons: some View {
    HStack(spacing: 10) {
      Button {
        play(shuffled: false)
      } label: {
        Label("Play", systemImage: "play.fill")
          .font(.headline)
          .padding(.horizontal, 10)
      }
      .buttonStyle(.glassProminent)
      .tint(Color.orbis.tint)
      .accessibilityIdentifier("playlist-play")
      Button {
        play(shuffled: true)
      } label: {
        Label("Shuffle", systemImage: "shuffle")
          .font(.headline)
          .padding(.horizontal, 6)
      }
      .buttonStyle(.glass)
      .accessibilityIdentifier("playlist-shuffle")
    }
    .controlSize(.large)
  }

  private func memberList(_ sets: [SavedSet]) -> some View {
    List {
      hero(sets)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .moveDisabled(true)
      ForEach(sets) { set in
        let presentation = SetPresentation.row(set)
        SetRow(
          title: presentation.title,
          source: presentation.source,
          artwork: presentation.artwork,
          creator: presentation.creator,
          length: presentation.length,
          dates: SetPresentation.datesLine(set),
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
    .scrollContentBackground(.hidden)
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectStyle(.soft, for: .bottom)
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
            .font(.orbis.detail)
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
            .font(.orbis.detail)
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
