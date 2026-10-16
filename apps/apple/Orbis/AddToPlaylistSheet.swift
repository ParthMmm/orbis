import OrbisDesign
import SwiftUI

struct AddToPlaylistSheet: View {
  @Bindable var model: AppModel
  let set: SavedSet

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var order: PlaylistChoices.Order = .recentlyAdded
  @State private var isCreating = false
  @State private var newName = ""
  @AppStorage(AppModel.recentPlaylistIdsKey) private var recentStore = ""

  static var newPlacement: ToolbarItemPlacement {
    #if os(iOS)
      .bottomBar
    #else
      .automatic
    #endif
  }

  var body: some View {
    NavigationStack {
      List {
        if query.isEmpty, !recents.isEmpty {
          Section("Recents") {
            ForEach(recents) { row($0, identifier: "add-to-playlist-recent-\($0.id)") }
          }
        }
        if !matching.isEmpty {
          Section(query.isEmpty ? "All Playlists" : "Playlists") {
            ForEach(matching) { row($0, identifier: "add-to-playlist-all-\($0.id)") }
          }
        }
      }
      .listStyle(.plain)
      .overlay {
        switch model.playlists {
        case .idle, .loading:
          LoadingState()
            .accessibilityIdentifier("add-to-playlist-loading")
        case .failed(let failure):
          UnavailableState(failure: failure, context: "loading playlists") {
            Task { await model.loadPlaylists() }
          }
          .accessibilityIdentifier("add-to-playlist-error")
        case .loaded(let items) where items.isEmpty:
          ContentUnavailableView {
            Label("No Playlists", systemImage: "music.note.list")
          } description: {
            Text("Make one with the + button, and this Set goes in first.")
          }
        case .loaded:
          if matching.isEmpty {
            ContentUnavailableView.search(text: query)
          }
        }
      }
      // The sheet covers the screen it came from, so what a choice or a new Playlist refused is
      // said here.
      .setChangeStatus(model)
      .playlistChangeStatus(model)
      .playlistSearch(text: $query)
      .navigationTitle("Add to Playlist")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close", systemImage: "xmark", role: .close) { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          Menu("Sort", systemImage: "arrow.up.arrow.down") {
            Picker("Sort", selection: $order) {
              ForEach(PlaylistChoices.Order.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.inline)
          }
        }
        ToolbarItem(placement: Self.newPlacement) {
          Button("New Playlist", systemImage: "plus") {
            newName = ""
            isCreating = true
          }
          .accessibilityIdentifier("add-to-playlist-new")
        }
      }
      .alert("New Playlist", isPresented: $isCreating) {
        TextField("Name", text: $newName)
        Button("Create") { createAndAdd() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("\(set.title) goes in first.")
      }
    }
    .presentationDetents([.large])
    .task {
      if model.playlists == .idle { await model.loadPlaylists() }
    }
  }

  // MARK: Rows

  private func row(_ playlist: Playlist, identifier: String) -> some View {
    let isMember = memberships.contains(playlist.id)
    return Button {
      choose(playlist, isMember: isMember)
    } label: {
      HStack(spacing: 14) {
        PlaylistCover(name: playlist.name)
        VStack(alignment: .leading, spacing: 2) {
          Text(playlist.name)
            .font(.orbis.body)
            .foregroundStyle(.primary)
            .lineLimit(1)
          Text(playlist.setCount == 1 ? "1 set" : "\(playlist.setCount) sets")
            .font(.orbis.detail)
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        if isMember {
          Image(systemName: "checkmark.circle.fill")
            .font(.title3)
            .foregroundStyle(Color.orbis.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(model.isWorkingOnSet)
    .accessibilityLabel(playlist.name)
    .accessibilityValue(isMember ? "Added" : "")
    .accessibilityHint(isMember ? "Removes this Set" : "Adds this Set")
    .accessibilityIdentifier(identifier)
  }

  // MARK: Data

  private var memberships: Set<String> {
    Set(model.savedSet(set.id)?.playlistIds ?? set.playlistIds)
  }

  private var choices: PlaylistChoices {
    PlaylistChoices(
      playlists: model.playlistItems, recentIds: recentStore.split(separator: ",").map(String.init))
  }

  private var recents: [Playlist] { choices.recents }

  private var matching: [Playlist] { choices.matching(query, in: order) }

  // MARK: Actions

  private func choose(_ playlist: Playlist, isMember: Bool) {
    Task {
      guard await model.choosePlaylist(playlist.id, for: set.id, isMember: isMember) else { return }
      remember(playlist.id)
    }
  }

  private func createAndAdd() {
    let name = newName
    Task {
      guard let created = await model.createPlaylist(named: name, adding: set.id) else { return }
      remember(created.id)
    }
  }

  /// Puts the Playlist the Set went into at the front of the recents, and closes the sheet.
  private func remember(_ playlistId: String) {
    recentStore = PlaylistChoices.remembering(playlistId, in: choices.recentIds).joined(separator: ",")
    dismiss()
  }
}

struct PlaylistCover: View {
  let name: String
  var size: CGFloat = 56

  var body: some View {
    let tone = SetPresentation.category(for: name).dot
    RoundedRectangle(cornerRadius: Radius.button)
      .fill(
        LinearGradient(
          colors: [tone, tone.mix(with: .black, by: 0.45)],
          startPoint: .topLeading, endPoint: .bottomTrailing)
      )
      .overlay(alignment: .topLeading) {
        Text(name)
          .font(.system(size: size * 0.16, weight: .semibold))
          .foregroundStyle(.white)
          .lineLimit(2)
          .padding(size * 0.1)
      }
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

extension View {
  fileprivate func playlistSearch(text: Binding<String>) -> some View {
    #if os(iOS)
      searchable(
        text: text, placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Find in Playlists")
    #else
      searchable(text: text, prompt: "Find in Playlists")
    #endif
  }
}
