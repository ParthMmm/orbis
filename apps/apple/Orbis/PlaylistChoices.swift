import Foundation

/// What the Add to Playlist sheet offers: the Playlists narrowed by a query and put in the order
/// chosen, and the few a Set went into most recently.
struct PlaylistChoices {
  enum Order: String, CaseIterable, Identifiable {
    case recentlyAdded = "Recently Added"
    case name = "Name"
    case size = "Most Sets"
    var id: Self { self }
  }

  static let recentLimit = 3

  let playlists: [Playlist]
  /// The Playlists a Set last went into on this device, newest first.
  let recentIds: [String]

  var recents: [Playlist] {
    let byId = Dictionary(uniqueKeysWithValues: playlists.map { ($0.id, $0) })
    return Array(recentIds.compactMap { byId[$0] }.prefix(Self.recentLimit))
  }

  func matching(_ query: String, in order: Order) -> [Playlist] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let found =
      trimmed.isEmpty
      ? playlists
      : playlists.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    return Self.sorted(found, by: order)
  }

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

  static func remembering(_ id: String, in recent: [String], limit: Int = 12) -> [String] {
    Array(([id] + recent.filter { $0 != id }).prefix(limit))
  }
}
