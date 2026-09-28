import OrbisDesign
import SwiftUI

/// Add to Playlist, the way a music app asks: a sheet with the Playlists used most recently, then
/// all of them, a field to find one, and a button to make a new one.
///
/// Choosing a Playlist adds the Set and closes the sheet, because that is the whole errand. A
/// Playlist that already holds the Set carries a checkmark, and choosing it takes the Set out
/// and leaves the sheet up, so an accidental add is undone in the same place.
struct AddToPlaylistSheet: View {
  @Bindable var model: AppModel
  let set: SavedSet

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var order: Order = .recentlyAdded
  @State private var isCreating = false
  @State private var newName = ""
  /// The Playlists this device added to last, newest first. Kept on the device: it is a
  /// convenience of this sheet, not a fact about the library.
  @AppStorage("orbis.recentPlaylistIds") private var recentStore = ""

  enum Order: String, CaseIterable, Identifiable {
    case recentlyAdded = "Recently Added"
    case name = "Name"
    case size = "Most Sets"
    var id: Self { self }
  }

  /// Where New Playlist sits: the bottom bar on iPhone, the toolbar elsewhere.
  static var newPlacement: ToolbarItemPlacement {
    #if os(iOS)
      .bottomBar
    #else
      .automatic
    #endif
  }

  /// How many Playlists the Recents section shows.
  static let recentLimit = 3

  var body: some View {
    NavigationStack {
      List {
        if query.isEmpty, !recents.isEmpty {
          Section("Recents") {
            ForEach(recents) { row($0) }
          }
        }
        if !matching.isEmpty {
          Section(query.isEmpty ? "All Playlists" : "Playlists") {
            ForEach(matching) { row($0) }
          }
        }
      }
      .listStyle(.plain)
      .overlay {
        if model.playlistItems.isEmpty {
          ContentUnavailableView {
            Label("No Playlists", systemImage: "music.note.list")
          } description: {
            Text("Make one with the + button, and this Set goes in first.")
          }
        } else if matching.isEmpty {
          ContentUnavailableView.search(text: query)
        }
      }
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
              ForEach(Order.allCases) { Text($0.rawValue).tag($0) }
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

  private func row(_ playlist: Playlist) -> some View {
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
    .accessibilityIdentifier("add-to-playlist-\(playlist.name)")
  }

  // MARK: Data

  private var memberships: Set<String> {
    Set(model.savedSet(set.id)?.playlistIds ?? set.playlistIds)
  }

  private var recentIds: [String] {
    recentStore.split(separator: ",").map(String.init)
  }

  private var recents: [Playlist] {
    let byId = Dictionary(uniqueKeysWithValues: model.playlistItems.map { ($0.id, $0) })
    return Array(recentIds.compactMap { byId[$0] }.prefix(Self.recentLimit))
  }

  private var matching: [Playlist] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let found =
      trimmed.isEmpty
      ? model.playlistItems
      : model.playlistItems.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    return Self.sorted(found, by: order)
  }

  /// The service lists Playlists newest first, so "Recently Added" keeps its order.
  static func sorted(_ playlists: [Playlist], by order: Order) -> [Playlist] {
    switch order {
    case .recentlyAdded:
      playlists
    case .name:
      playlists.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    case .size:
      playlists.sorted { $0.setCount > $1.setCount }
    }
  }

  /// The recent list with `id` at its head, each Playlist once.
  static func remembering(_ id: String, in recent: [String], limit: Int = 12) -> [String] {
    Array(([id] + recent.filter { $0 != id }).prefix(limit))
  }

  // MARK: Actions

  private func choose(_ playlist: Playlist, isMember: Bool) {
    Task {
      await model.setMembership(set.id, in: playlist.id, !isMember)
      guard model.setFailure == nil, !isMember else { return }
      recentStore = Self.remembering(playlist.id, in: recentIds).joined(separator: ",")
      dismiss()
    }
  }

  private func createAndAdd() {
    let name = newName
    Task {
      guard let created = await model.createPlaylist(named: name, opening: false) else { return }
      await model.setMembership(set.id, in: created.id, true)
      guard model.setFailure == nil else { return }
      recentStore = Self.remembering(created.id, in: recentIds).joined(separator: ",")
      dismiss()
    }
  }
}

/// A Playlist's cover: its colour, as a gradient, with its name in the corner, the way a music
/// app draws a Playlist that has no picture of its own.
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
  /// The search field, pinned open under the title on iPhone the way a music app's picker has it.
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
