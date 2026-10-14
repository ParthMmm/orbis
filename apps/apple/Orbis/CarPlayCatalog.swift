import Foundation
import OrbisDesign

/// What the car shows, read from the model in one pass. A value, so the scene redraws only when
/// it changes, and so the rules for what reaches the car hold without a car to look at.
///
/// Only Sets with Retained Audio reach the car: a row there is a promise that a tap plays.
struct CarPlayCatalog: Equatable {
  /// A tab's state before it has rows: still loading, or a reason it has none.
  enum Status: Equatable {
    case loading
    case signedOut
    case failed(OrbisFailure)
    case ready
  }

  let library: Status
  let playlistsStatus: Status
  /// Home, picked by the same rules as the phone's, from the playable Sets.
  let home: HomeSelection
  let playlists: [Playlist]
  /// Every playable Set, in the Library's order.
  let sets: [SavedSet]
  /// The Set in the player, which its rows mark.
  let playingSetId: String?
  /// The Tracklist of the Set in the player, for Up Next.
  let cues: [Cue]

  @MainActor
  init(model: AppModel) {
    guard model.isConfigured else {
      library = .signedOut
      playlistsStatus = .signedOut
      home = HomeSelection(library: [], visible: [])
      playlists = []
      sets = []
      playingSetId = nil
      cues = []
      return
    }
    let all = if case .loaded(let sets) = model.library { sets } else { [SavedSet]() }
    let visible = if case .loaded(let sets) = model.visibleSets { sets } else { [SavedSet]() }
    library = Self.status(of: model.library)
    playlistsStatus = Self.status(of: model.playlists)
    sets = all.filter(Self.isPlayable)
    home = HomeSelection(library: sets, visible: visible.filter(Self.isPlayable))
    playlists = model.playlistItems
    playingSetId = model.audioPlayer.currentSetId
    cues = playingSetId.flatMap { model.tracklists[$0]?.cues } ?? []
  }

  static func isPlayable(_ set: SavedSet) -> Bool { set.downloadState == "ready" }

  private static func status<Value>(of loadable: Loadable<Value>) -> Status {
    switch loadable {
    case .idle, .loading: .loading
    case .loaded: .ready
    case .failed(let failure): .failed(failure)
    }
  }
}
